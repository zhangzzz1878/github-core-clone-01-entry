// app.ts — HTTP server for the forge: auth, body reading, routing, replies.
// Hand-written for the github-core-clone-01 bounty entry. Node built-ins only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createStore, type ApiResult,
  getRepo,
} from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  v0Advertisement, v2Advertisement, handleLsRefs, handleFetchV2, handleFetchV0,
  handleReceivePack, splitPktBody,
} from './gitproto.ts';

const ENV_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function parseJson(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function authOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  if (ENV_TOKEN) return token === ENV_TOKEN;
  return true; // no token configured: any non-empty Bearer is accepted
}

function send(res: ServerResponse, result: ApiResult, requestId: string): void {
  const headers: Record<string, string> = { 'X-GitHub-Request-Id': requestId };
  if (result.headers) Object.assign(headers, result.headers);
  if (result.status === 204 || (result.json === undefined && result.raw === undefined)) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  if (result.raw !== undefined) {
    headers['Content-Type'] = result.contentType ?? 'application/octet-stream';
    res.writeHead(result.status, headers);
    res.end(result.raw);
    return;
  }
  headers['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(result.status, headers);
  res.end(JSON.stringify(result.json));
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function createApp() {
  const store = createStore();
  const server = createServer((req, res) => {
    void (async () => {
      const requestId = `req-${++store.requestSeq}`;
      try {
        const rawUrl = req.url ?? '/';
        const host = req.headers.host ?? '127.0.0.1';
        const url = new URL(rawUrl, `http://${host}`);
        const baseUrl = `http://${host}`;
        const pathname = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const segments = pathname.split('/').filter((s) => s.length > 0).map(decodeSegment);

        // /healthz is open (the env probes it without a token).
        if (pathname === '/healthz' && method === 'GET') {
          send(res, { status: 200, json: { status: 'ok' } }, requestId);
          return;
        }

        if (!authOk(req)) {
          send(res, { status: 401, json: { message: 'Unauthorized' } }, requestId);
          return;
        }

        const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const rawBody = hasBody ? await readBody(req) : Buffer.alloc(0);

        // MCP endpoint.
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            send(res, { status: 204 }, requestId);
            return;
          }
          if (method !== 'POST') {
            send(res, { status: 404, json: { message: 'Not Found' } }, requestId);
            return;
          }
          const parsed = parseJson(rawBody);
          if (!parsed.ok) {
            send(res, { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }, requestId);
            return;
          }
          send(res, handleMcp(store, parsed.value), requestId);
          return;
        }

        // GraphQL endpoint.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            send(res, { status: 404, json: { message: 'Not Found' } }, requestId);
            return;
          }
          const parsed = parseJson(rawBody);
          if (!parsed.ok) {
            send(res, { status: 400, json: { errors: [{ message: 'Invalid JSON' }] } }, requestId);
            return;
          }
          const result = handleGraphQL(store, parsed.value);
          send(res, { status: result.status, json: result.json }, requestId);
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const restSegments = pathname === '/api/v3' ? [] : segments.slice(2);
          let body: unknown = null;
          if (hasBody && rawBody.length > 0) {
            const parsed = parseJson(rawBody);
            if (!parsed.ok) {
              send(res, { status: 400, json: { message: 'Invalid JSON' } }, requestId);
              return;
            }
            body = parsed.value;
          }
          send(res, handleRest({
            store,
            method,
            segments: restSegments,
            query: url.searchParams,
            body,
            baseUrl,
            path: pathname,
          }), requestId);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -4);
          const repo = getRepo(store, owner, repoName);
          if (!repo) {
            send(res, { status: 404, json: { message: 'Not Found' } }, requestId);
            return;
          }
          const rest = segments.slice(2);
          const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

          if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs' && method === 'GET') {
            const service = url.searchParams.get('service');
            if (service === 'git-upload-pack') {
              const body = isV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
              send(res, { status: 200, raw: body, contentType: 'application/x-git-upload-pack-advertisement' }, requestId);
              return;
            }
            if (service === 'git-receive-pack') {
              const body = v0Advertisement(repo, 'git-receive-pack');
              send(res, { status: 200, raw: body, contentType: 'application/x-git-receive-pack-advertisement' }, requestId);
              return;
            }
            send(res, { status: 404, json: { message: 'Not Found' } }, requestId);
            return;
          }

          if (rest.length === 1 && rest[0] === 'git-upload-pack' && method === 'POST') {
            const { lines } = splitPktBody(rawBody);
            const first = (lines[0] ?? '').replace(/\n$/, '');
            if (first === 'command=ls-refs') {
              const body = handleLsRefs(repo, rawBody);
              send(res, { status: 200, raw: body, contentType: 'application/x-git-upload-pack-result' }, requestId);
              return;
            }
            if (first === 'command=fetch') {
              const body = handleFetchV2(repo, rawBody);
              send(res, { status: 200, raw: body, contentType: 'application/x-git-upload-pack-result' }, requestId);
              return;
            }
            if (first.startsWith('want ')) {
              const body = handleFetchV0(repo, rawBody);
              send(res, { status: 200, raw: body, contentType: 'application/x-git-upload-pack-result' }, requestId);
              return;
            }
            // Malformed upload-pack request: answer 400 and stay healthy.
            send(res, { status: 400, json: { message: 'Invalid git request' } }, requestId);
            return;
          }

          if (rest.length === 1 && rest[0] === 'git-receive-pack' && method === 'POST') {
            const { body } = handleReceivePack(repo, rawBody);
            send(res, { status: 200, raw: body, contentType: 'application/x-git-receive-pack-result' }, requestId);
            return;
          }

          send(res, { status: 404, json: { message: 'Not Found' } }, requestId);
          return;
        }

        send(res, { status: 404, json: { message: 'Not Found' } }, requestId);
      } catch (err) {
        // Never let one request take the process down.
        try {
          send(res, { status: 500, json: { message: err instanceof Error ? err.message : 'Internal Server Error' } }, requestId);
        } catch {
          try { res.destroy(); } catch { /* ignore */ }
        }
      }
    })();
  });
  return server;
}

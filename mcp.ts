// mcp.ts — Model Context Protocol endpoint (JSON-RPC 2.0) for the forge.
// Hand-written for the github-core-clone-01 bounty entry. Node built-ins only.
// Modern era 2026-07-28 with a legacy `initialize` fallback.

import {
  VIEWER_LOGIN, VIEWER_ID,
  type Store, type ApiResult,
  getRepo, createRepo, createIssue, createPull, squashMergePull, computeMergeable,
  repoJson, issueJson, pullJson,
} from './store.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

// The tool list is a single constant: tools/list is byte-identical across calls.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_REQUIRED: Record<string, string[]> = {};
for (const t of TOOLS) TOOL_REQUIRED[t.name] = t.inputSchema.required;

function textResult(data: unknown): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const required = TOOL_REQUIRED[name] ?? [];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length) return errorResult(`missing required argument: ${missing.join(', ')}`);

  if (name === 'create_repo') {
    const repoName = argStr(args, 'name')!;
    if (getRepo(store, VIEWER_LOGIN, repoName)) return errorResult(`Repository "${repoName}" already exists`);
    const repo = createRepo(store, repoName, {
      description: argStr(args, 'description'),
      private: typeof args.private === 'boolean' ? args.private : false,
    });
    return textResult(repoJson(repo));
  }

  if (name === 'get_repo') {
    const owner = argStr(args, 'owner')!;
    const repoName = argStr(args, 'repo')!;
    const repo = getRepo(store, owner, repoName);
    if (!repo) return errorResult('Repository not found');
    return textResult(repoJson(repo));
  }

  if (name === 'create_issue') {
    const owner = argStr(args, 'owner')!;
    const repoName = argStr(args, 'repo')!;
    const repo = getRepo(store, owner, repoName);
    if (!repo) return errorResult('Repository not found');
    const issue = createIssue(store, repo, argStr(args, 'title')!, argStr(args, 'body') ?? '', []);
    return textResult(issueJson(repo, issue));
  }

  if (name === 'list_issues') {
    const owner = argStr(args, 'owner')!;
    const repoName = argStr(args, 'repo')!;
    const repo = getRepo(store, owner, repoName);
    if (!repo) return errorResult('Repository not found');
    const state = argStr(args, 'state') ?? 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    const issues = list.map((i) => issueJson(repo, i));
    return textResult({ issues });
  }

  if (name === 'create_pull_request') {
    const owner = argStr(args, 'owner')!;
    const repoName = argStr(args, 'repo')!;
    const repo = getRepo(store, owner, repoName);
    if (!repo) return errorResult('Repository not found');
    const head = argStr(args, 'head')!;
    const base = argStr(args, 'base')!;
    const pull = createPull(store, repo, argStr(args, 'title')!, argStr(args, 'body') ?? '', head, base);
    if (!pull) return errorResult('head or base branch does not exist');
    return textResult(pullJson(repo, pull));
  }

  if (name === 'merge_pull_request') {
    const owner = argStr(args, 'owner')!;
    const repoName = argStr(args, 'repo')!;
    const repo = getRepo(store, owner, repoName);
    if (!repo) return errorResult('Repository not found');
    const num = argNum(args, 'pull_number');
    if (num === undefined) return errorResult('missing required argument: pull_number');
    const pull = repo.pulls.get(num);
    if (!pull) return errorResult('Pull request not found');
    if (pull.state !== 'open') return errorResult('Pull request is not open');
    if (computeMergeable(repo, pull) === 'CONFLICTING') return errorResult('Merge conflict');
    const sha = squashMergePull(store, repo, pull);
    if (!sha) return errorResult('Merge conflict');
    return textResult({ merged: true, sha, number: pull.number, message: `Pull request #${pull.number} merged` });
  }

  return errorResult(`Unknown tool: ${name}`);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function handleMcp(store: Store, body: unknown): ApiResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, json: rpcError(null, -32700, 'Parse error') };
  }
  const req = body as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(req, 'id');
  const method = typeof req.method === 'string' ? req.method : '';
  if (!hasId) {
    // Notification (e.g. notifications/initialized): acknowledge, no body.
    return { status: 202 };
  }
  const id = req.id ?? null;

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      status: 200,
      json: rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      }),
    };
  }
  if (method === 'initialize') {
    return {
      status: 200,
      json: rpcResult(id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, json: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>)
      : {};
    if (!toolName) return { status: 200, json: rpcError(id, -32602, 'tool name is required') };
    if (!TOOL_REQUIRED[toolName]) {
      return { status: 200, json: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
    const result = callTool(store, toolName, args);
    return { status: 200, json: rpcResult(id, result) };
  }
  return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
}

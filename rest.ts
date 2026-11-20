// rest.ts — GitHub REST API v3 surface for the forge.
// Hand-written for the github-core-clone-01 bounty entry. Node built-ins only.

import {
  VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, DEFAULT_BRANCH, FIXED_TS,
  type Store, type Repo, type ApiResult,
  getRepo, createRepo, deleteRepo, storeObject, getBranchTip, branchRef,
  walkCommits, parseCommit, parseTree, flattenTree, diffTrees, treeOfCommit,
  updateTreePath, lookupPath, listTreeDir, makeApiCommit, computeMergeable, squashMergePull,
  mergeBase,
  createIssue, createLabel, createComment, createPull,
  repoJson, issueJson, commentJson, labelJson, pullJson, commitJson, userJson, globalId,
} from './store.ts';

export interface RestRequest {
  store: Store;
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: unknown; // parsed JSON body (null when no body)
  baseUrl: string; // e.g. http://127.0.0.1:PORT
  path: string; // pathname (no query)
}

function notFound(message = 'Not Found'): ApiResult {
  return { status: 404, json: { message } };
}

function badRequest(message: string): ApiResult {
  return { status: 400, json: { message } };
}

function unprocessable(message: string): ApiResult {
  return { status: 422, json: { message } };
}

function conflict(message: string): ApiResult {
  return { status: 409, json: { message } };
}

function bodyObj(req: RestRequest): Record<string, unknown> {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>;
  }
  return {};
}

function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function strArrayField(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string') as string[];
  return [];
}

// Paginate a list; returns the page slice and a Link header value (or null).
function paginate<T>(items: T[], req: RestRequest): { page: T[]; link: string | null } {
  const rawPer = parseInt(req.query.get('per_page') ?? '', 10);
  const perPage = Number.isNaN(rawPer) ? 30 : Math.min(100, Math.max(1, rawPer));
  const rawPage = parseInt(req.query.get('page') ?? '', 10);
  const page = Number.isNaN(rawPage) ? 1 : Math.max(1, rawPage);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const next = `${req.baseUrl}${req.path}?per_page=${perPage}&page=${page + 1}`;
    const last = `${req.baseUrl}${req.path}?per_page=${perPage}&page=${lastPage}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: slice, link };
}

function linkHeaders(link: string | null): Record<string, string> | undefined {
  return link ? { Link: link } : undefined;
}

// Resolve a repo from segments [repos, owner, name]; null when missing or
// the owner is not the viewer (404, never 403).
function resolveRepo(req: RestRequest): Repo | null {
  const owner = req.segments[1];
  const name = req.segments[2];
  if (!owner || !name) return null;
  return getRepo(req.store, owner, name) ?? null;
}

// Resolve a ref name or commit oid to a commit oid.
function resolveRefCommit(repo: Repo, ref: string | undefined): string | null {
  if (!ref) {
    return getBranchTip(repo, repo.defaultBranch) ?? null;
  }
  const branchTip = getBranchTip(repo, ref);
  if (branchTip) return branchTip;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = repo.objects.get(ref);
    if (obj && obj.type === 'commit') return ref;
  }
  return null;
}

export function handleRest(req: RestRequest): ApiResult {
  const seg = req.segments;
  const m = req.method;

  // GET /api/v3/ — API root.
  if (seg.length === 0) {
    if (m !== 'GET') return notFound();
    return {
      status: 200,
      headers: { 'X-OAuth-Scopes': 'repo, read:org' },
      json: {
        current_user_url: `${req.baseUrl}/api/v3/user`,
        user_url: `${req.baseUrl}/api/v3/users/{user}`,
        repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${req.baseUrl}/api/v3/rate_limit`,
        meta_url: `${req.baseUrl}/api/v3/meta`,
      },
    };
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (m !== 'GET') return notFound();
    return {
      status: 200,
      json: {
        installed_version: '1.0.0',
        verifiable_password_authentication: true,
        github_services_sha: '0000000000000000000000000000000000000000',
        hooks: ['127.0.0.1'],
        git: ['127.0.0.1'],
        pages: [],
        importer: [],
        actions: [],
      },
    };
  }

  // GET /api/v3/user
  if (seg.length === 1 && seg[0] === 'user') {
    if (m !== 'GET') return notFound();
    return {
      status: 200,
      json: {
        ...userJson(VIEWER_LOGIN, VIEWER_ID),
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        company: null,
        blog: '',
        location: '',
        bio: '',
        public_repos: req.store.repoList.length,
        followers: 0,
        following: 0,
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
      },
    };
  }

  // /api/v3/user/repos — list / create.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (m === 'GET') {
      const { page, link } = paginate(req.store.repoList, req);
      return { status: 200, headers: linkHeaders(link), json: page.map((r) => repoJson(r)) };
    }
    if (m === 'POST') {
      const b = bodyObj(req);
      const name = strField(b, 'name');
      if (!name) return unprocessable('name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return unprocessable('name is invalid');
      if (getRepo(req.store, VIEWER_LOGIN, name)) {
        return unprocessable(`Repository "${name}" already exists`);
      }
      const repo = createRepo(req.store, name, {
        description: strField(b, 'description'),
        private: typeof b.private === 'boolean' ? b.private : false,
      });
      return { status: 201, json: repoJson(repo) };
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const repo = resolveRepo(req);
    if (!repo) return notFound();
    const rest = seg.slice(3);

    // GET/PATCH/DELETE /repos/{owner}/{name}
    if (rest.length === 0) {
      if (m === 'GET') return { status: 200, json: repoJson(repo) };
      if (m === 'PATCH') {
        const b = bodyObj(req);
        const description = strField(b, 'description');
        if (description !== undefined) repo.description = description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        const db = strField(b, 'default_branch');
        if (db && getBranchTip(repo, db)) repo.defaultBranch = db;
        return { status: 200, json: repoJson(repo) };
      }
      if (m === 'DELETE') {
        deleteRepo(req.store, repo);
        return { status: 204 };
      }
      return notFound();
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (m !== 'GET') return notFound();
      const branches = [...repo.refs.keys()]
        .filter((n) => n.startsWith('refs/heads/'))
        .sort()
        .map((n) => {
          const name = n.slice('refs/heads/'.length);
          return { name, commit: { sha: repo.refs.get(n)!, url: '' }, protected: false };
        });
      const { page, link } = paginate(branches, req);
      return { status: 200, headers: linkHeaders(link), json: page };
    }

    // GET /repos/{o}/{r}/branches/{branch}
    if (rest.length === 2 && rest[0] === 'branches') {
      if (m !== 'GET') return notFound();
      const tip = getBranchTip(repo, rest[1]);
      if (!tip) return notFound();
      return { status: 200, json: { name: rest[1], commit: { sha: tip, url: '' }, protected: false } };
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (rest.length === 1 && rest[0] === 'commits') {
      if (m !== 'GET') return notFound();
      const tip = resolveRefCommit(repo, req.query.get('sha') ?? undefined);
      if (!tip) return notFound();
      const oids: string[] = [];
      walkCommits(repo, [tip], new Set(), (oid) => oids.push(oid));
      const { page, link } = paginate(oids.map((oid) => commitJson(repo, oid)), req);
      return { status: 200, headers: linkHeaders(link), json: page };
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (m !== 'POST') return notFound();
      const b = bodyObj(req);
      const ref = strField(b, 'ref');
      const sha = strField(b, 'sha');
      if (!ref || !ref.startsWith('refs/')) return unprocessable('ref is required');
      if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return unprocessable('sha is required');
      const obj = repo.objects.get(sha);
      if (!obj) return unprocessable('sha does not exist');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      return {
        status: 201,
        json: {
          ref,
          node_id: globalId('Ref', repo.id, ref),
          object: { sha, type: obj.type, url: '' },
          url: '',
        },
      };
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads') {
      if (m !== 'GET') return notFound();
      const tip = getBranchTip(repo, rest[3]);
      if (!tip) return notFound();
      const obj = repo.objects.get(tip);
      return {
        status: 200,
        json: {
          ref: branchRef(rest[3]),
          node_id: globalId('Ref', repo.id, branchRef(rest[3])),
          object: { sha: tip, type: obj?.type ?? 'commit', url: '' },
          url: '',
        },
      };
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      return handleContents(req, repo, rest.slice(1));
    }

    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (m !== 'POST') return notFound();
      const b = bodyObj(req);
      const name = strField(b, 'name');
      const color = strField(b, 'color') ?? 'ededed';
      if (!name) return unprocessable('name is required');
      if (repo.labels.has(name)) return unprocessable('Label already exists');
      const label = createLabel(repo, name, color.replace(/^#/, ''), strField(b, 'description'));
      return { status: 201, json: labelJson(repo, label) };
    }

    // /repos/{o}/{r}/issues[...]
    if (rest.length >= 1 && rest[0] === 'issues') {
      return handleIssues(req, repo, rest.slice(1));
    }

    // /repos/{o}/{r}/pulls[...]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return handlePulls(req, repo, rest.slice(1));
    }

    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const parts = buf.toString('utf8').split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function fileContentJson(repo: Repo, path: string, blobOid: string): Record<string, unknown> {
  const obj = repo.objects.get(blobOid);
  const data = obj && obj.type === 'blob' ? obj.data : Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: blobOid,
    url: '',
    git_url: '',
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: '',
  };
}

function handleContents(req: RestRequest, repo: Repo, pathSegs: string[]): ApiResult {
  const m = req.method;
  const path = pathSegs.join('/');

  if (m === 'GET') {
    const tip = resolveRefCommit(repo, req.query.get('ref') ?? undefined);
    if (!tip) return notFound();
    const treeOid = treeOfCommit(repo, tip);
    if (pathSegs.length === 0) {
      const entries = listTreeDir(repo, treeOid);
      const out = entries.map((e) => {
        const obj = repo.objects.get(e.oid);
        const size = obj && obj.type === 'blob' ? obj.data.length : 0;
        return { type: e.mode === '40000' ? 'dir' : 'file', size, name: e.name, path: e.name, sha: e.oid, url: '', git_url: '', html_url: '', download_url: '' };
      });
      return { status: 200, json: out };
    }
    const found = lookupPath(repo, treeOid, pathSegs);
    if (!found) return notFound();
    if (found.kind === 'dir') {
      const entries = listTreeDir(repo, found.oid);
      const out = entries.map((e) => {
        const obj = repo.objects.get(e.oid);
        const size = obj && obj.type === 'blob' ? obj.data.length : 0;
        return { type: e.mode === '40000' ? 'dir' : 'file', size, name: e.name, path: `${path}/${e.name}`, sha: e.oid, url: '', git_url: '', html_url: '', download_url: '' };
      });
      return { status: 200, json: out };
    }
    return { status: 200, json: fileContentJson(repo, path, found.oid) };
  }

  if (m === 'PUT') {
    const b = bodyObj(req);
    const message = strField(b, 'message');
    const content = strField(b, 'content');
    if (!message) return unprocessable('message is required');
    if (content === undefined) return unprocessable('content is required');
    const branch = strField(b, 'branch') ?? repo.defaultBranch;
    const sha = strField(b, 'sha');
    let data: Buffer;
    try {
      data = Buffer.from(content, 'base64');
    } catch {
      return unprocessable('content is not valid base64');
    }
    const tip = getBranchTip(repo, branch);
    const defaultTip = getBranchTip(repo, repo.defaultBranch);
    let parents: string[];
    let rootTree: string | null;
    if (tip) {
      parents = [tip];
      rootTree = treeOfCommit(repo, tip);
    } else if (defaultTip) {
      // Creating a new branch from the default-branch tip.
      parents = [defaultTip];
      rootTree = treeOfCommit(repo, defaultTip);
    } else {
      parents = [];
      rootTree = null;
    }
    const existing = lookupPath(repo, rootTree, pathSegs);
    let isUpdate = false;
    if (existing) {
      if (existing.kind === 'dir') return unprocessable('path is a directory');
      if (!sha) return unprocessable('sha is required to update a file');
      if (sha !== existing.oid) return conflict('sha does not match the current file');
      isUpdate = true;
    } else if (sha) {
      return unprocessable('sha does not match any existing file');
    }
    const blobOid = storeObject(repo, 'blob', data);
    const newTree = updateTreePath(repo, rootTree, pathSegs, blobOid);
    const commitSha = makeApiCommit(repo, newTree, parents, message);
    repo.refs.set(branchRef(branch), commitSha);
    repo.packCache.clear();
    return {
      status: isUpdate ? 200 : 201,
      json: {
        content: { ...fileContentJson(repo, path, blobOid), encoding: 'base64' },
        commit: { sha: commitSha, message },
      },
    };
  }

  if (m === 'DELETE') {
    const b = bodyObj(req);
    const message = strField(b, 'message');
    const sha = strField(b, 'sha');
    if (!message) return unprocessable('message is required');
    if (!sha) return unprocessable('sha is required');
    const branch = strField(b, 'branch') ?? repo.defaultBranch;
    const tip = getBranchTip(repo, branch);
    if (!tip) return notFound();
    const rootTree = treeOfCommit(repo, tip);
    const existing = lookupPath(repo, rootTree, pathSegs);
    if (!existing) return notFound();
    if (existing.kind === 'dir') return unprocessable('path is a directory');
    if (sha !== existing.oid) return conflict('sha does not match the current file');
    const newTree = updateTreePath(repo, rootTree, pathSegs, null);
    const commitSha = makeApiCommit(repo, newTree, [tip], message);
    repo.refs.set(branchRef(branch), commitSha);
    repo.packCache.clear();
    return { status: 200, json: { content: null, commit: { sha: commitSha, message } } };
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function handleIssues(req: RestRequest, repo: Repo, rest: string[]): ApiResult {
  const m = req.method;

  if (rest.length === 0) {
    if (m === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, link } = paginate(list.map((i) => issueJson(repo, i)), req);
      return { status: 200, headers: link ? { Link: link } : undefined, json: page };
    }
    if (m === 'POST') {
      const b = bodyObj(req);
      const title = strField(b, 'title');
      if (!title) return unprocessable('title is required');
      const body = strField(b, 'body') ?? '';
      const labelNames = strArrayField(b, 'labels');
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return unprocessable(`Label "${name}" does not exist`);
      }
      const issue = createIssue(req.store, repo, title, body, labelNames);
      return { status: 201, json: issueJson(repo, issue) };
    }
    return notFound();
  }

  const num = parseInt(rest[0], 10);
  if (Number.isNaN(num)) return notFound();
  const issue = repo.issues.get(num);
  if (!issue) return notFound();

  if (rest.length === 1) {
    if (m === 'GET') {
      const cached = repo.issueJsonCache.get(num);
      if (cached) return { status: 200, raw: cached, contentType: 'application/json; charset=utf-8' };
      const buf = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
      repo.issueJsonCache.set(num, buf);
      return { status: 200, raw: buf, contentType: 'application/json; charset=utf-8' };
    }
    if (m === 'PATCH') {
      const b = bodyObj(req);
      const title = strField(b, 'title');
      const body = strField(b, 'body');
      const state = strField(b, 'state');
      if (title !== undefined) issue.title = title;
      if (body !== undefined) issue.body = body;
      if (state === 'open' || state === 'closed') issue.state = state;
      repo.issueJsonCache.delete(num);
      return { status: 200, json: issueJson(repo, issue) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (m === 'GET') {
      const { page, link } = paginate(issue.comments.map((c) => commentJson(repo, issue, c)), req);
      return { status: 200, headers: link ? { Link: link } : undefined, json: page };
    }
    if (m === 'POST') {
      const b = bodyObj(req);
      const body = strField(b, 'body');
      if (!body) return unprocessable('body is required');
      const comment = createComment(req.store, repo, issue, body);
      return { status: 201, json: commentJson(repo, issue, comment) };
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function handlePulls(req: RestRequest, repo: Repo, rest: string[]): ApiResult {
  const m = req.method;

  if (rest.length === 0) {
    if (m === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, link } = paginate(list.map((p) => pullJson(repo, p)), req);
      return { status: 200, headers: link ? { Link: link } : undefined, json: page };
    }
    if (m === 'POST') {
      const b = bodyObj(req);
      const title = strField(b, 'title');
      const head = strField(b, 'head');
      const base = strField(b, 'base');
      if (!title) return unprocessable('title is required');
      if (!head || !base) return unprocessable('head and base are required');
      if (!getBranchTip(repo, head) || !getBranchTip(repo, base)) {
        return unprocessable('head or base branch does not exist');
      }
      const pull = createPull(req.store, repo, title, strField(b, 'body') ?? '', head, base);
      if (!pull) return unprocessable('head or base branch does not exist');
      return { status: 201, json: pullJson(repo, pull) };
    }
    return notFound();
  }

  const num = parseInt(rest[0], 10);
  if (Number.isNaN(num)) return notFound();
  const pull = repo.pulls.get(num);
  if (!pull) return notFound();

  if (rest.length === 1) {
    if (m === 'GET') return { status: 200, json: pullJson(repo, pull) };
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (m !== 'GET') return notFound();
    const headTip = getBranchTip(repo, pull.headRef);
    const baseTip = getBranchTip(repo, pull.baseRef);
    if (!headTip || !baseTip) return notFound();
    const base = mergeBase(repo, headTip, baseTip);
    const baseTree = base ? treeOfCommit(repo, base) : null;
    const headTree = treeOfCommit(repo, headTip);
    const changes = diffTrees(repo, baseTree, headTree);
    const files = changes.map((ch) => {
      const oldData = ch.oldOid ? repo.objects.get(ch.oldOid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      const newData = ch.newOid ? repo.objects.get(ch.newOid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      const additions = ch.status === 'removed' ? 0 : countLines(newData);
      const deletions = ch.status === 'added' ? 0 : countLines(oldData);
      return {
        sha: ch.newOid ?? ch.oldOid ?? '',
        filename: ch.path,
        status: ch.status,
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      };
    });
    return { status: 200, json: files };
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (m !== 'PUT') return notFound();
    if (pull.state !== 'open') {
      return { status: 405, json: { message: 'Pull request is not open' } };
    }
    if (computeMergeable(repo, pull) === 'CONFLICTING') {
      return { status: 405, json: { message: 'Merge conflict' } };
    }
    const sha = squashMergePull(req.store, repo, pull);
    if (!sha) return { status: 405, json: { message: 'Merge conflict' } };
    return { status: 200, json: { merged: true, sha, message: `Pull request #${pull.number} merged` } };
  }

  return notFound();
}

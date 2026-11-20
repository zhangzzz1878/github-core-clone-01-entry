// graphql.ts — a small hand-written GraphQL parser + executor for the forge.
// Hand-written for the github-core-clone-01 bounty entry. Node built-ins only.
// Supports: operations, variables, aliases, inline fragments, fragment
// spreads, inline enum lists, inline input objects, null variables, batching.

import {
  VIEWER_LOGIN,
  type Store, type Repo, type Issue, type Pull,
  getRepo, createIssue, createComment, createPull, computeMergeable,
  squashMergePull, globalId, mergeBase, treeOfCommit, diffTrees, getBranchTip,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
interface Tok { kind: TokKind; value: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { out.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { out.push({ kind: 'punct', value: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const esc = src[j + 1];
          if (esc === 'u' && j + 5 < n) {
            value += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            value += map[esc] ?? esc;
            j += 2;
          }
        } else {
          value += src[j];
          j++;
        }
      }
      out.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j++; while (j < n && src[j] >= '0' && src[j] <= '9') j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      }
      out.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (j < n && ((src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= 'a' && src[j] <= 'z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '_')) j++;
      out.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown character: skip it rather than failing the whole document.
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser (variables are resolved inline from the request's variables)
// ---------------------------------------------------------------------------

export interface GqlField {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, unknown>;
  children: GqlSelection[];
}
export interface GqlFragment {
  kind: 'fragment';
  onType?: string;
  children: GqlSelection[];
}
export type GqlSelection = GqlField | GqlFragment;

export interface GqlOperation {
  kind: 'query' | 'mutation';
  selections: GqlSelection[];
}

class Parser {
  private pos = 0;
  private tokens: Tok[];
  private variables: Record<string, unknown>;
  constructor(tokens: Tok[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Tok | undefined { return this.tokens[this.pos]; }
  private next(): Tok | undefined { return this.tokens[this.pos++]; }
  private expect(value: string): void {
    const t = this.next();
    if (!t || t.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(): string {
    const t = this.next();
    if (!t || t.kind !== 'name') throw new Error('expected name');
    return t.value;
  }

  parseDocument(): { operation: GqlOperation; fragments: Record<string, GqlSelection[]> } {
    const fragments: Record<string, GqlSelection[]> = {};
    let operation: GqlOperation | null = null;
    while (this.peek()) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        const selections = this.parseSelectionSet();
        operation = { kind: 'query', selections };
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.next()!.value as 'query' | 'mutation';
        // Optional operation name.
        if (this.peek()?.kind === 'name') this.next();
        // Optional variable definitions: ($x: Type = default, ...)
        if (this.peek()?.value === '(') this.parseVariableDefinitions();
        // Optional directives: skip @name(args).
        while (this.peek()?.value === '@') this.skipDirective();
        const selections = this.parseSelectionSet();
        operation = { kind, selections };
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expect('on');
        const onType = this.expectName();
        const selections = this.parseSelectionSet();
        fragments[name] = [{ kind: 'fragment', onType, children: selections }];
      } else {
        this.next(); // skip anything unexpected
      }
    }
    if (!operation) throw new Error('no operation in document');
    return { operation, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (this.peek() && depth > 0) {
      const t = this.next()!;
      if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
      else if (t.value === ')' || t.value === ']' || t.value === '}') depth--;
    }
  }

  private skipDirective(): void {
    this.expect('@');
    this.expectName();
    if (this.peek()?.value === '(') this.parseArguments();
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (this.peek() && this.peek()!.value !== '}') {
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  private parseSelection(): GqlSelection {
    const t = this.peek()!;
    if (t.kind === 'spread') {
      this.next();
      if (this.peek()?.kind === 'name' && this.peek()!.value === 'on') {
        this.next();
        const onType = this.expectName();
        const children = this.parseSelectionSet();
        return { kind: 'fragment', onType, children };
      }
      if (this.peek()?.kind === 'name') {
        const name = this.next()!.value;
        // Fragment spread: resolved by the executor; represent as a fragment
        // with no type condition and a marker name.
        return { kind: 'fragment', onType: `__spread:${name}`, children: [] };
      }
      const children = this.parseSelectionSet();
      return { kind: 'fragment', children };
    }
    // Field: [alias:] name (args) { children }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peek()?.value === '(') args = this.parseArguments();
    while (this.peek()?.value === '@') this.skipDirective();
    let children: GqlSelection[] = [];
    if (this.peek()?.value === '{') children = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, children };
  }

  private parseArguments(): Record<string, unknown> {
    this.expect('(');
    const args: Record<string, unknown> = {};
    while (this.peek() && this.peek()!.value !== ')') {
      const name = this.expectName();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): unknown {
    const t = this.next();
    if (!t) throw new Error('unexpected end of document');
    if (t.kind === 'punct' && t.value === '$') {
      const name = this.expectName();
      const v = this.variables[name];
      return v === undefined ? null : v;
    }
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return parseInt(t.value, 10);
    if (t.kind === 'float') return parseFloat(t.value);
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // enum value
    }
    if (t.kind === 'punct' && t.value === '[') {
      const list: unknown[] = [];
      while (this.peek() && this.peek()!.value !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() && this.peek()!.value !== '}') {
        const name = this.expectName();
        this.expect(':');
        obj[name] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    throw new Error(`unexpected token ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface GqlObj { __typename: string; [key: string]: unknown }
type GqlValue = GqlObj | string | number | boolean | null;
type Resolver = (value: GqlObj, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

interface ExecCtx {
  store: Store;
  errors: { message: string }[];
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function decodeGlobalId(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || !id) return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function findRepoById(store: Store, id: number): Repo | undefined {
  return store.repoList.find((r) => r.id === id);
}

function wrapIssue(repo: Repo, issue: Issue): GqlObj {
  return { __typename: 'Issue', repo, issue };
}

function wrapPull(repo: Repo, pull: Pull): GqlObj {
  return { __typename: 'PullRequest', repo, pull };
}

function wrapRepo(repo: Repo): GqlObj {
  return { __typename: 'Repository', repo };
}

function repoOf(value: GqlObj): Repo {
  return value.repo as Repo;
}

function issueOf(value: GqlObj): Issue {
  return value.issue as Issue;
}

function pullOf(value: GqlObj): Pull {
  return value.pull as Pull;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const dir = orderBy?.direction === 'DESC' ? -1 : 1;
  list.sort((a, b) => (a.number - b.number) * dir);
  const afterNum = decodeCursor(args.after);
  let start = 0;
  if (afterNum !== null) {
    const idx = list.findIndex((i) => i.number === afterNum);
    if (idx !== -1) start = idx + 1;
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => wrapIssue(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      endCursor: page.length ? encodeCursor(page[page.length - 1].number) : null,
      hasPreviousPage: start > 0,
      startCursor: page.length ? encodeCursor(page[0].number) : null,
    },
    totalCount: list.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    list = list.filter((p) => {
      const s = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(s);
    });
  } else {
    list = list.filter((p) => p.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  const afterNum = decodeCursor(args.after);
  let start = 0;
  if (afterNum !== null) {
    const idx = list.findIndex((p) => p.number === afterNum);
    if (idx !== -1) start = idx + 1;
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => wrapPull(repo, pull)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      endCursor: page.length ? encodeCursor(page[page.length - 1].number) : null,
      hasPreviousPage: start > 0,
      startCursor: page.length ? encodeCursor(page[0].number) : null,
    },
    totalCount: list.length,
  };
}

function prState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prFiles(repo: Repo, pull: Pull, args: Record<string, unknown>): GqlObj {
  const headTip = getBranchTip(repo, pull.headRef) ?? null;
  const baseTip = getBranchTip(repo, pull.baseRef) ?? null;
  let nodes: GqlObj[] = [];
  if (headTip && baseTip) {
    const base = mergeBase(repo, headTip, baseTip);
    const baseTree = base ? treeOfCommit(repo, base) : null;
    const headTree = treeOfCommit(repo, headTip);
    const changes = diffTrees(repo, baseTree, headTree);
    const first = typeof args.first === 'number' ? args.first : changes.length;
    nodes = changes.slice(0, first).map((ch) => ({ __typename: 'PullRequestChangedFile', path: ch.path }));
  }
  return { __typename: 'PullRequestChangedFileConnection', nodes };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: VIEWER_LOGIN }),
    repository: (_v, args, ctx) => {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (!owner || !name) return null;
      const repo = getRepo(ctx.store, owner, name);
      return repo ? wrapRepo(repo) : null;
    },
    node: (_v, args, ctx) => {
      const decoded = decodeGlobalId(args.id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(ctx.store, parseInt(decoded.parts[0], 10));
        return repo ? wrapRepo(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = findRepoById(ctx.store, parseInt(decoded.parts[0], 10));
        const issue = repo?.issues.get(parseInt(decoded.parts[1], 10));
        return repo && issue ? wrapIssue(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = findRepoById(ctx.store, parseInt(decoded.parts[0], 10));
        const pull = repo?.pulls.get(parseInt(decoded.parts[1], 10));
        return repo && pull ? wrapPull(repo, pull) : null;
      }
      return null;
    },
    __type: (_v, args) => {
      const name = args.name as string | undefined;
      if (!name) return null;
      if (TYPE_FIELDS[name]) {
        return {
          __typename: '__Type',
          name,
          kind: 'OBJECT',
          fields: TYPE_FIELDS[name].map((f) => ({ __typename: '__Field', name: f })),
          enumValues: null,
        };
      }
      if (name === 'SearchType') {
        return {
          __typename: '__Type',
          name,
          kind: 'ENUM',
          fields: null,
          enumValues: ['ISSUE', 'REPOSITORY', 'USER'].map((f) => ({ __typename: '__EnumValue', name: f })),
        };
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (_v, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.repositoryId);
      const repo = decoded ? findRepoById(ctx.store, parseInt(decoded.parts[0], 10)) : undefined;
      if (!repo) throw new Error('repository not found');
      const title = input.title as string | undefined;
      if (!title) throw new Error('title is required');
      const issue = createIssue(ctx.store, repo, title, (input.body as string | undefined) ?? '', []);
      return { __typename: 'CreateIssuePayload', issue: wrapIssue(repo, issue) };
    },
    closeIssue: (_v, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.issueId);
      const repo = decoded ? findRepoById(ctx.store, parseInt(decoded.parts[0], 10)) : undefined;
      const issue = repo?.issues.get(decoded ? parseInt(decoded.parts[1], 10) : -1);
      if (!repo || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      repo.issueJsonCache.delete(issue.number);
      return { __typename: 'CloseIssuePayload', issue: wrapIssue(repo, issue) };
    },
    createPullRequest: (_v, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.repositoryId);
      const repo = decoded ? findRepoById(ctx.store, parseInt(decoded.parts[0], 10)) : undefined;
      if (!repo) throw new Error('repository not found');
      const title = input.title as string | undefined;
      const head = input.headRefName as string | undefined;
      const base = input.baseRefName as string | undefined;
      if (!title || !head || !base) throw new Error('title, headRefName and baseRefName are required');
      const pull = createPull(ctx.store, repo, title, (input.body as string | undefined) ?? '', head, base);
      if (!pull) throw new Error('head or base branch does not exist');
      return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pull) };
    },
    mergePullRequest: (_v, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.pullRequestId);
      const repo = decoded ? findRepoById(ctx.store, parseInt(decoded.parts[0], 10)) : undefined;
      const pull = repo?.pulls.get(decoded ? parseInt(decoded.parts[1], 10) : -1);
      if (!repo || !pull) throw new Error('pull request not found');
      if (pull.state === 'open' && computeMergeable(repo, pull) !== 'CONFLICTING') {
        squashMergePull(ctx.store, repo, pull);
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(repo, pull) };
    },
    addComment: (_v, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.subjectId);
      const repo = decoded ? findRepoById(ctx.store, parseInt(decoded.parts[0], 10)) : undefined;
      const issue = repo?.issues.get(decoded ? parseInt(decoded.parts[1], 10) : -1);
      if (!repo || !issue) throw new Error('subject not found');
      const body = input.body as string | undefined;
      if (!body) throw new Error('body is required');
      const comment = createComment(ctx.store, repo, issue, body);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body },
        },
      };
    },
  },
  User: {
    login: (v) => v.login as string,
  },
  Repository: {
    id: (v) => globalId('Repository', repoOf(v).id),
    databaseId: (v) => repoOf(v).id,
    name: (v) => repoOf(v).name,
    nameWithOwner: (v) => `${repoOf(v).owner}/${repoOf(v).name}`,
    owner: (v) => ({ __typename: 'User', login: repoOf(v).owner }),
    defaultBranchRef: (v) => {
      const repo = repoOf(v);
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (v, args) => {
      const repo = repoOf(v);
      const issue = repo.issues.get(args.number as number);
      return issue ? wrapIssue(repo, issue) : null;
    },
    issues: (v, args) => issuesConnection(repoOf(v), args),
    pullRequests: (v, args) => pullsConnection(repoOf(v), args),
    pullRequest: (v, args) => {
      const repo = repoOf(v);
      const pull = repo.pulls.get(args.number as number);
      return pull ? wrapPull(repo, pull) : null;
    },
  },
  Issue: {
    id: (v) => globalId('Issue', repoOf(v).id, issueOf(v).number),
    number: (v) => issueOf(v).number,
    title: (v) => issueOf(v).title,
    state: (v) => (issueOf(v).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (v) => issueOf(v).body,
  },
  PullRequest: {
    id: (v) => globalId('PullRequest', repoOf(v).id, pullOf(v).number),
    number: (v) => pullOf(v).number,
    state: (v) => prState(pullOf(v)),
    merged: (v) => pullOf(v).merged,
    headRefName: (v) => pullOf(v).headRef,
    baseRefName: (v) => pullOf(v).baseRef,
    mergeable: (v) => computeMergeable(repoOf(v), pullOf(v)),
    files: (v, args) => prFiles(repoOf(v), pullOf(v), args),
  },
  IssueConnection: {
    nodes: (v) => v.nodes as GqlValue[],
    pageInfo: (v) => v.pageInfo as GqlValue,
    totalCount: (v) => v.totalCount as number,
  },
  PullRequestConnection: {
    nodes: (v) => v.nodes as GqlValue[],
    pageInfo: (v) => v.pageInfo as GqlValue,
    totalCount: (v) => v.totalCount as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (v) => v.nodes as GqlValue[],
  },
  PullRequestChangedFile: {
    path: (v) => v.path as string,
  },
  PageInfo: {
    hasNextPage: (v) => v.hasNextPage as boolean,
    endCursor: (v) => v.endCursor as string | null,
    hasPreviousPage: (v) => v.hasPreviousPage as boolean,
    startCursor: (v) => v.startCursor as string | null,
  },
  Ref: {
    name: (v) => v.name as string,
  },
  __Type: {
    name: (v) => v.name as string,
    kind: (v) => v.kind as string,
    fields: (v) => v.fields as GqlValue[] | null,
    enumValues: (v) => v.enumValues as GqlValue[] | null,
  },
  __Field: {
    name: (v) => v.name as string,
  },
  __EnumValue: {
    name: (v) => v.name as string,
  },
  CreateIssuePayload: { issue: (v) => v.issue as GqlValue },
  CloseIssuePayload: { issue: (v) => v.issue as GqlValue },
  CreatePullRequestPayload: { pullRequest: (v) => v.pullRequest as GqlValue },
  MergePullRequestPayload: { pullRequest: (v) => v.pullRequest as GqlValue },
  AddCommentPayload: { commentEdge: (v) => v.commentEdge as GqlValue },
  IssueCommentEdge: { node: (v) => v.node as GqlValue },
  IssueComment: {
    id: (v) => v.id as string,
    body: (v) => v.body as string,
  },
};

function childTypeName(child: unknown): string | null {
  if (child && typeof child === 'object' && '__typename' in (child as Record<string, unknown>)) {
    return (child as GqlObj).__typename;
  }
  return null;
}

function executeSelections(
  ctx: ExecCtx,
  typeName: string,
  value: GqlValue,
  selections: GqlSelection[],
  fragments: Record<string, GqlSelection[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.onType?.startsWith('__spread:')) {
        const frag = fragments[sel.onType.slice('__spread:'.length)];
        if (frag) Object.assign(out, executeSelections(ctx, typeName, value, frag, fragments));
        continue;
      }
      if (sel.onType && value && typeof value === 'object') {
        if ((value as GqlObj).__typename !== sel.onType) continue;
      }
      Object.assign(out, executeSelections(ctx, typeName, value, sel.children, fragments));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[sel.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    let child: unknown;
    try {
      child = resolver(value as GqlObj, sel.args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'resolver error' });
      out[key] = null;
      continue;
    }
    if (sel.children.length > 0 && child !== null && child !== undefined) {
      if (Array.isArray(child)) {
        out[key] = child.map((item) => {
          const t = childTypeName(item);
          return t ? executeSelections(ctx, t, item, sel.children, fragments) : item;
        });
      } else if (typeof child === 'object') {
        const t = childTypeName(child);
        out[key] = t ? executeSelections(ctx, t, child as GqlValue, sel.children, fragments) : child;
      } else {
        out[key] = child;
      }
    } else {
      out[key] = child ?? null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function executeOne(store: Store, req: Record<string, unknown>): Record<string, unknown> {
  const query = typeof req.query === 'string' ? req.query : '';
  const variables = (req.variables && typeof req.variables === 'object' && !Array.isArray(req.variables))
    ? (req.variables as Record<string, unknown>)
    : {};
  if (!query) return { data: null, errors: [{ message: 'query is required' }] };
  let parsed;
  try {
    parsed = new Parser(tokenize(query), variables).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const ctx: ExecCtx = { store, errors: [] };
  const rootType = parsed.operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, { __typename: rootType }, parsed.operation.selections, parsed.fragments);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

export function handleGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((item) => (item && typeof item === 'object' ? executeOne(store, item as Record<string, unknown>) : { data: null, errors: [{ message: 'invalid request' }] })) };
  }
  if (body && typeof body === 'object') {
    return { status: 200, json: executeOne(store, body as Record<string, unknown>) };
  }
  return { status: 400, json: { errors: [{ message: 'GraphQL body must be an object or an array' }] } };
}

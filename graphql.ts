// GitHub GraphQL v4, hand-rolled for the documents gh and github-mcp-server
// actually send. A small parser (operations, variables, aliases, inline
// fragments, __type introspection) over the same store as REST, so a mutation
// here is visible there and vice versa.

import { doSquashMerge, mergeableState, pullConflicts } from './rest.ts';
import {
  commentGlobalId,
  globalId,
  issueGlobalId,
  parseGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  VIEWER,
  diffTrees,
  mergeBase,
  nowIso,
  tipTree,
} from './store.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():$![]=@&|'.includes(ch ?? '')) {
      tokens.push({ kind: 'punct', value: ch as string });
      i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === '"') value += '"';
          else if (esc === '\\') value += '\\';
          else if (esc === '/') value += '/';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else if (esc !== undefined) value += esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch !== undefined && /[0-9-]/.test(ch)) {
      let num = '';
      while (i < source.length && /[0-9.eE+-]/.test(source[i] ?? '')) {
        num += source[i];
        i += 1;
      }
      if (num.includes('.') || num.includes('e') || num.includes('E')) tokens.push({ kind: 'float', value: Number(num) });
      else tokens.push({ kind: 'int', value: parseInt(num, 10) });
      continue;
    }
    if (ch !== undefined && /[_A-Za-z]/.test(ch)) {
      let name = '';
      while (i < source.length && /[_A-Za-z0-9]/.test(source[i] ?? '')) {
        name += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    throw new Error(`GraphQL lexer: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] };

export interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('GraphQL parser: unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`GraphQL parser: expected ${value}, got ${JSON.stringify(token)}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`GraphQL parser: expected a name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let operation: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') name = this.next().value;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.parseVariableDefinitions();
    }
    this.skipDirectives();
    const selection = this.parseSelectionSet();
    return { operation, name, variables: {}, selection };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (next?.kind === 'name') {
        throw new Error('GraphQL parser: fragment spreads are not supported');
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
    }
    return { kind: 'field', field: this.parseField() };
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`GraphQL parser: unexpected value token ${JSON.stringify(token)}`);
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- introspection data

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'url', 'repository', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'closedAt', 'author', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Ref: ['name', 'target'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------- executor

interface GqlContext {
  store: Store;
  errors: { message: string }[];
}

interface TypedValue {
  type: string;
  value: unknown;
}

function err(ctx: GqlContext, message: string): void {
  ctx.errors.push({ message });
}

function findRepoByGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const repoId = Number(parsed.key);
  for (const repo of store.repos.values()) if (repo.id === repoId) return repo;
  return null;
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':').map(Number);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':').map(Number);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.get(number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionResult {
  nodes: unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): ConnectionResult {
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = typeof args.after === 'string' ? args.after : null;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  let list = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const afterNumber = numberFromCursor(after);
  if (afterNumber !== null) {
    const index = list.findIndex((i) => i.number === afterNumber);
    if (index >= 0) list = list.slice(index + 1);
  }
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return { nodes: page, pageInfo: { hasNextPage, endCursor } };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): ConnectionResult {
  const first = typeof args.first === 'number' ? args.first : 10;
  const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  const page = list.slice(0, first);
  return { nodes: page, pageInfo: { hasNextPage: list.length > page.length, endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null } };
}

/** Execute one selection set against a typed value; returns the JSON value (or null). */
function executeSelection(ctx: GqlContext, typed: TypedValue, selection: SelectionNode[], variables: Record<string, unknown>): unknown {
  if (typed.value === null || typed.value === undefined) return null;
  if (PAYLOAD_TYPES.has(typed.type)) {
    const out: Record<string, unknown> = {};
    for (const node of selection) {
      if (node.kind === 'inlineFragment') continue;
      const field = node.field;
      out[field.alias ?? field.name] = executePayloadField(ctx, typed, field, variables);
    }
    return out;
  }
  if (typed.type === 'PullRequestChangedFileConnection') {
    const value = typed.value as { nodes: { path: string }[]; pageInfo: unknown };
    const out: Record<string, unknown> = {};
    for (const node of selection) {
      if (node.kind === 'inlineFragment') continue;
      const field = node.field;
      if (field.name === 'nodes') {
        out[field.alias ?? 'nodes'] = value.nodes.map((n) => {
          if (field.selection === null) return n;
          const row: Record<string, unknown> = {};
          for (const sub of field.selection) {
            if (sub.kind === 'field' && sub.field.name === 'path') row[sub.field.alias ?? 'path'] = n.path;
          }
          return row;
        });
      } else if (field.name === 'pageInfo') {
        out[field.alias ?? 'pageInfo'] = value.pageInfo;
      } else {
        err(ctx, `Cannot query field "${field.name}" on type "PullRequestChangedFileConnection".`);
        out[field.alias ?? field.name] = null;
      }
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'inlineFragment') {
      if (node.typeCondition !== null && node.typeCondition !== typed.type) continue;
      const fragment = executeSelection(ctx, typed, node.selection, variables);
      if (fragment !== null && typeof fragment === 'object') Object.assign(out, fragment);
      continue;
    }
    const field = node.field;
    const key = field.alias ?? field.name;
    out[key] = executeField(ctx, typed, field, variables);
  }
  return out;
}

function executeField(ctx: GqlContext, typed: TypedValue, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args = argsOf(field, variables);
  const value = typed.value as Record<string, unknown>;
  switch (typed.type) {
    case 'Query':
      return executeQueryField(ctx, field, args, variables);
    case 'Mutation':
      return executeMutationField(ctx, field, args, variables);
    case 'Repository':
      return executeRepoField(ctx, value as unknown as Repo, field, args, variables);
    case 'Issue':
      return executeIssueField(ctx, value as unknown as Issue & { __repo: Repo }, field, args, variables);
    case 'PullRequest':
      return executePullField(ctx, value as unknown as Pull & { __repo: Repo }, field, args, variables);
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        const nodes = (value.nodes as unknown[]).map((item) => {
          const itemType = typed.type === 'IssueConnection' ? 'Issue' : 'PullRequest';
          return field.selection === null ? item : executeSelection(ctx, { type: itemType, value: item }, field.selection, variables);
        });
        return nodes;
      }
      if (field.name === 'pageInfo') {
        return field.selection === null ? value.pageInfo : executeSelection(ctx, { type: 'PageInfo', value: value.pageInfo }, field.selection, variables);
      }
      if (field.name === 'totalCount') return (value.nodes as unknown[]).length;
      err(ctx, `Cannot query field "${field.name}" on type "${typed.type}".`);
      return null;
    }
    case 'PageInfo':
      if (field.name === 'hasNextPage' || field.name === 'endCursor' || field.name === 'hasPreviousPage' || field.name === 'startCursor') {
        return (value as Record<string, unknown>)[field.name] ?? null;
      }
      err(ctx, `Cannot query field "${field.name}" on type "PageInfo".`);
      return null;
    case 'User':
      if (field.name === 'login') return (value as { login: string }).login;
      if (field.name === 'id') return (value as { id: number }).id;
      if (field.name === 'name') return (value as { name?: string }).name ?? null;
      err(ctx, `Cannot query field "${field.name}" on type "User".`);
      return null;
    case 'Ref':
      if (field.name === 'name') return (value as { name: string }).name;
      err(ctx, `Cannot query field "${field.name}" on type "Ref".`);
      return null;
    case 'IssueComment':
      if (field.name === 'id') return (value as { id: string }).id;
      if (field.name === 'body') return (value as { body: string }).body;
      err(ctx, `Cannot query field "${field.name}" on type "IssueComment".`);
      return null;
    case '__Type': {
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[(value as { name: string }).name] ?? [];
        return names.map((n) => ({ name: n }));
      }
      if (field.name === 'enumValues') {
        const names = TYPE_ENUM_VALUES[(value as { name: string }).name] ?? [];
        return names.map((n) => ({ name: n }));
      }
      if (field.name === 'name') return (value as { name: string }).name;
      err(ctx, `Cannot query field "${field.name}" on type "__Type".`);
      return null;
    }
    default:
      err(ctx, `Cannot query field "${field.name}" on type "${typed.type}".`);
      return null;
  }
}

function executeQueryField(ctx: GqlContext, field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
  if (field.name === '__type') {
    const name = typeof args.name === 'string' ? args.name : '';
    const value = { name };
    return field.selection === null ? value : executeSelection(ctx, { type: '__Type', value }, field.selection, variables);
  }
  if (field.name === 'viewer') {
    const value = { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name };
    return field.selection === null ? value : executeSelection(ctx, { type: 'User', value }, field.selection, variables);
  }
  if (field.name === 'repository') {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const name = typeof args.name === 'string' ? args.name : '';
    const repo = owner === VIEWER.login ? ctx.store.getRepo(owner, name) : undefined;
    if (repo === undefined) return null;
    return field.selection === null ? repo : executeSelection(ctx, { type: 'Repository', value: repo }, field.selection, variables);
  }
  if (field.name === 'node') {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    if (parsed.kind === 'Repository') {
      const repoId = Number(parsed.key);
      for (const repo of ctx.store.repos.values()) {
        if (repo.id === repoId) {
          return field.selection === null ? repo : executeSelection(ctx, { type: 'Repository', value: repo }, field.selection, variables);
        }
      }
      return null;
    }
    if (parsed.kind === 'Issue') {
      const found = findIssueByGlobalId(ctx.store, id);
      if (found === null) return null;
      const value = { ...found.issue, __repo: found.repo };
      return field.selection === null ? value : executeSelection(ctx, { type: 'Issue', value }, field.selection, variables);
    }
    if (parsed.kind === 'PullRequest') {
      const found = findPullByGlobalId(ctx.store, id);
      if (found === null) return null;
      const value = { ...found.pull, __repo: found.repo };
      return field.selection === null ? value : executeSelection(ctx, { type: 'PullRequest', value }, field.selection, variables);
    }
    return null;
  }
  err(ctx, `Cannot query field "${field.name}" on type "Query".`);
  return null;
}

function executeRepoField(ctx: GqlContext, repo: Repo, field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
  switch (field.name) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner': {
      const value = { login: repo.owner, id: VIEWER.id, name: VIEWER.name };
      return field.selection === null ? value : executeSelection(ctx, { type: 'User', value }, field.selection, variables);
    }
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      const value = { name: repo.defaultBranch };
      return field.selection === null ? value : executeSelection(ctx, { type: 'Ref', value }, field.selection, variables);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.get(number);
      if (issue === undefined) return null;
      const value = { ...issue, __repo: repo };
      return field.selection === null ? value : executeSelection(ctx, { type: 'Issue', value }, field.selection, variables);
    }
    case 'issues': {
      const connection = issueConnection(repo, args);
      const value = { nodes: connection.nodes.map((i) => ({ ...(i as Issue), __repo: repo })), pageInfo: connection.pageInfo };
      return field.selection === null ? value : executeSelection(ctx, { type: 'IssueConnection', value }, field.selection, variables);
    }
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return null;
      const value = { ...pull, __repo: repo };
      return field.selection === null ? value : executeSelection(ctx, { type: 'PullRequest', value }, field.selection, variables);
    }
    case 'pullRequests': {
      const connection = pullConnection(repo, args);
      const value = { nodes: connection.nodes.map((p) => ({ ...(p as Pull), __repo: repo })), pageInfo: connection.pageInfo };
      return field.selection === null ? value : executeSelection(ctx, { type: 'PullRequestConnection', value }, field.selection, variables);
    }
    default:
      err(ctx, `Cannot query field "${field.name}" on type "Repository".`);
      return null;
  }
}

function executeIssueField(ctx: GqlContext, issue: Issue & { __repo: Repo }, field: FieldNode, _args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
  switch (field.name) {
    case 'id':
      return issueGlobalId(issue.__repo, issue.number);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    case 'author': {
      const value = { login: issue.user.login, id: issue.user.id, name: issue.user.name };
      return field.selection === null ? value : executeSelection(ctx, { type: 'User', value }, field.selection, variables);
    }
    case 'repository': {
      const value = issue.__repo;
      return field.selection === null ? value : executeSelection(ctx, { type: 'Repository', value }, field.selection, variables);
    }
    default:
      err(ctx, `Cannot query field "${field.name}" on type "Issue".`);
      return null;
  }
}

function executePullField(ctx: GqlContext, pull: Pull & { __repo: Repo }, field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
  switch (field.name) {
    case 'id':
      return pullGlobalId(pull.__repo, pull.number);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'mergeable':
      return pull.merged ? 'UNKNOWN' : mergeableState(pull.__repo, pull);
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'createdAt':
      return pull.createdAt;
    case 'updatedAt':
      return pull.updatedAt;
    case 'author': {
      const value = { login: pull.user.login, id: pull.user.id, name: pull.user.name };
      return field.selection === null ? value : executeSelection(ctx, { type: 'User', value }, field.selection, variables);
    }
    case 'repository': {
      const value = pull.__repo;
      return field.selection === null ? value : executeSelection(ctx, { type: 'Repository', value }, field.selection, variables);
    }
    case 'files': {
      const base = mergeBase(pull.__repo, pull.headSha, pull.baseSha);
      const baseTree = base === null ? undefined : tipTree(pull.__repo, base);
      const headTree = tipTree(pull.__repo, pull.headSha);
      const changes = diffTrees(pull.__repo, baseTree, headTree);
      const first = typeof args.first === 'number' ? args.first : 10;
      const nodes = changes.slice(0, first).map((c) => ({ path: c.path }));
      const value = { nodes, pageInfo: { hasNextPage: changes.length > first, endCursor: null } };
      return field.selection === null ? value : executeSelection(ctx, { type: 'PullRequestChangedFileConnection', value }, field.selection, variables);
    }
    default:
      err(ctx, `Cannot query field "${field.name}" on type "PullRequest".`);
      return null;
  }
}

function executeMutationField(ctx: GqlContext, field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const store = ctx.store;
  if (field.name === 'createIssue') {
    const repo = findRepoByGlobalId(store, input.repositoryId);
    if (repo === null) {
      err(ctx, 'Could not resolve to a Repository with the id provided.');
      return null;
    }
    const title = typeof input.title === 'string' ? input.title : '';
    const bodyText = typeof input.body === 'string' ? input.body : '';
    const stamp = nowIso();
    const number = repo.nextNumber++;
    const issue: Issue = { number, title, body: bodyText, state: 'open', labels: [], user: VIEWER, createdAt: stamp, updatedAt: stamp, closedAt: null };
    repo.issues.set(number, issue);
    repo.issueComments.set(number, []);
    const value = { issue: { ...issue, __repo: repo } };
    return field.selection === null ? value : executeSelection(ctx, { type: 'CreateIssuePayload', value }, field.selection, variables);
  }
  if (field.name === 'closeIssue') {
    const found = findIssueByGlobalId(store, input.issueId);
    if (found === null) {
      err(ctx, 'Could not resolve to an Issue with the id provided.');
      return null;
    }
    found.issue.state = 'closed';
    found.issue.closedAt = nowIso();
    found.issue.updatedAt = nowIso();
    const value = { issue: { ...found.issue, __repo: found.repo } };
    return field.selection === null ? value : executeSelection(ctx, { type: 'CloseIssuePayload', value }, field.selection, variables);
  }
  if (field.name === 'createPullRequest') {
    const repo = findRepoByGlobalId(store, input.repositoryId);
    if (repo === null) {
      err(ctx, 'Could not resolve to a Repository with the id provided.');
      return null;
    }
    const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
    const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const title = typeof input.title === 'string' ? input.title : '';
    const bodyText = typeof input.body === 'string' ? input.body : '';
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (headTip === undefined || baseTip === undefined) {
      err(ctx, 'Head or base ref does not exist.');
      return null;
    }
    const stamp = nowIso();
    const number = repo.nextNumber++;
    const pull: Pull = {
      number,
      title,
      body: bodyText,
      state: 'open',
      headRef,
      baseRef,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: VIEWER,
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
    };
    repo.pulls.set(number, pull);
    const value = { pullRequest: { ...pull, __repo: repo } };
    return field.selection === null ? value : executeSelection(ctx, { type: 'CreatePullRequestPayload', value }, field.selection, variables);
  }
  if (field.name === 'mergePullRequest') {
    const found = findPullByGlobalId(store, input.pullRequestId);
    if (found === null) {
      err(ctx, 'Could not resolve to a PullRequest with the id provided.');
      return null;
    }
    if (found.pull.merged || found.pull.state === 'closed') {
      err(ctx, 'Pull request is already closed.');
      return null;
    }
    if (pullConflicts(found.repo, found.pull)) {
      err(ctx, 'Merge conflict.');
      return null;
    }
    doSquashMerge(found.repo, found.pull);
    const value = { pullRequest: { ...found.pull, __repo: found.repo } };
    return field.selection === null ? value : executeSelection(ctx, { type: 'MergePullRequestPayload', value }, field.selection, variables);
  }
  if (field.name === 'addComment') {
    const found = findIssueByGlobalId(store, input.subjectId);
    if (found === null) {
      err(ctx, 'Could not resolve to an Issue with the id provided.');
      return null;
    }
    const bodyText = typeof input.body === 'string' ? input.body : '';
    const stamp = nowIso();
    const commentId = found.repo.nextCommentId++;
    const comment = { id: commentId, body: bodyText, user: VIEWER, createdAt: stamp, updatedAt: stamp };
    found.repo.issueComments.get(found.issue.number)!.push(comment);
    const value = { commentEdge: { node: { id: commentGlobalId(found.repo, found.issue.number, commentId), body: bodyText } } };
    return field.selection === null ? value : executeSelection(ctx, { type: 'AddCommentPayload', value }, field.selection, variables);
  }
  err(ctx, `Cannot query field "${field.name}" on type "Mutation".`);
  return null;
}

// Payload types resolve their single object field generically.
function executePayloadField(ctx: GqlContext, typed: TypedValue, field: FieldNode, variables: Record<string, unknown>): unknown {
  const value = typed.value as Record<string, unknown>;
  const inner = value[field.name] as Record<string, unknown> | undefined;
  if (inner === undefined) {
    err(ctx, `Cannot query field "${field.name}" on type "${typed.type}".`);
    return null;
  }
  if (field.name === 'issue') {
    const issue = inner as unknown as Issue & { __repo: Repo };
    return field.selection === null ? inner : executeSelection(ctx, { type: 'Issue', value: issue }, field.selection, variables);
  }
  if (field.name === 'pullRequest') {
    const pull = inner as unknown as Pull & { __repo: Repo };
    return field.selection === null ? inner : executeSelection(ctx, { type: 'PullRequest', value: pull }, field.selection, variables);
  }
  if (field.name === 'commentEdge') {
    const edge = inner as { node: { id: string; body: string } };
    if (field.selection === null) return edge;
    const out: Record<string, unknown> = {};
    for (const node of field.selection) {
      if (node.kind === 'field' && node.field.name === 'node') {
        const nodeValue = edge.node;
        out[node.field.alias ?? 'node'] =
          node.field.selection === null ? nodeValue : executeSelection(ctx, { type: 'IssueComment', value: nodeValue }, node.field.selection, variables);
      }
    }
    return out;
  }
  err(ctx, `Cannot query field "${field.name}" on type "${typed.type}".`);
  return null;
}

const PAYLOAD_TYPES = new Set(['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']);

/** Execute one operation document against the store. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
): { data: unknown; errors?: { message: string }[] } {
  const ctx: GqlContext = { store, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'GraphQL document is empty' }] };
  const operation = operations[0];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, { type: rootType, value: {} }, operation.selection, variables);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle a POST /api/graphql body (single operation or a batch array). */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((item) => {
      if (typeof item !== 'object' || item === null) return { data: null, errors: [{ message: 'Invalid operation' }] };
      const record = item as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables ?? {}) as Record<string, unknown>;
      return executeGraphQL(store, query, variables);
    });
    return { status: 200, body: results };
  }
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    return { status: 200, body: executeGraphQL(store, query, variables) };
  }
  return { status: 400, body: { errors: [{ message: 'GraphQL request body must be a JSON object or array' }] } };
}

export { globalId };

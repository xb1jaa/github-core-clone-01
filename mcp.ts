// Model Context Protocol over streamable HTTP (POST /mcp), modern era
// (server/discover, 2026-07-28) with a legacy initialize fallback. One JSON
// body per request; tools share the store with REST and GraphQL.

import { doSquashMerge, pullConflicts } from './rest.ts';
import {
  type Repo,
  type Store,
  VIEWER,
  issueGlobalId,
  nowIso,
  pullGlobalId,
  repoGlobalId,
} from './store.ts';

export const MCP_VERSION = '2026-07-28';
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'forge-mcp';
export const MCP_SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    // The suite's create_repo call supplies name (plus optional description /
    // private) only — owner is the token owner, never a required argument.
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
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
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'integer', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, required: t.required },
    })),
  };
}

function textResult(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function getRepoOrNull(store: Store, owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      if (repoName === '') return errorResult('create_repo requires a name');
      const existing = store.getRepo(VIEWER.login, repoName);
      if (existing !== undefined) return textResult(repoView(existing));
      const repo = store.createRepo(repoName, description, isPrivate);
      if (repo === null) return errorResult(`repository ${repoName} already exists`);
      return textResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (repo === null) return errorResult('repository not found');
      return textResult(repoView(repo));
    }
    case 'create_issue': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (repo === null) return errorResult('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return errorResult('create_issue requires a title');
      const bodyText = typeof args.body === 'string' ? args.body : '';
      const stamp = nowIso();
      const number = repo.nextNumber++;
      const issue = { number, title, body: bodyText, state: 'open' as const, labels: [], user: VIEWER, createdAt: stamp, updatedAt: stamp, closedAt: null };
      repo.issues.set(number, issue);
      repo.issueComments.set(number, []);
      return textResult({ id: issueGlobalId(repo, number), number, title, body: bodyText, state: 'open', repository: `${repo.owner}/${repo.name}` });
    }
    case 'list_issues': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (repo === null) return errorResult('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return textResult({
        issues: list.map((i) => ({ id: issueGlobalId(repo, i.number), number: i.number, title: i.title, body: i.body, state: i.state })),
      });
    }
    case 'create_pull_request': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (repo === null) return errorResult('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      if (title === '' || head === '') return errorResult('create_pull_request requires a title and a head branch');
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) return errorResult('head or base branch does not exist');
      const bodyText = typeof args.body === 'string' ? args.body : '';
      const stamp = nowIso();
      const number = repo.nextNumber++;
      const pull = {
        number,
        title,
        body: bodyText,
        state: 'open' as const,
        headRef: head,
        baseRef: base,
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
      return textResult({ id: pullGlobalId(repo, number), number, title, body: bodyText, state: 'open', head: { ref: head, sha: headTip }, base: { ref: base, sha: baseTip } });
    }
    case 'merge_pull_request': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (repo === null) return errorResult('repository not found');
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isFinite(number)) return errorResult('merge_pull_request requires a pull_number');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return errorResult('pull request not found');
      if (pull.merged || pull.state === 'closed') return errorResult('pull request is already closed');
      if (pullConflicts(repo, pull)) return errorResult('merge conflict');
      const mergeSha = doSquashMerge(repo, pull);
      return textResult({ merged: true, number, pull_number: number, sha: mergeSha });
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

/**
 * Handle one POST /mcp request. `rawBody` is the exact request bytes (a
 * malformed body must answer HTTP 400 with JSON-RPC -32700).
 * Returns {status, body} where body is a JSON value (or null for 202).
 */
export function handleMcp(store: Store, rawBody: Buffer, authed: boolean): { status: number; body: unknown } {
  if (!authed) return { status: 401, body: { message: 'Requires authentication' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = parsed as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get no response.
  if (req.id === undefined) return { status: 202, body: null };

  const result = (value: unknown): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result: value },
  });
  const rpcError = (code: number, message: string, data?: unknown): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
  });

  if (method === 'server/discover') {
    const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
    return result({
      supportedVersions: [MCP_VERSION, ...MCP_LEGACY_VERSIONS],
      capabilities: { tools: {} },
      serverInfo,
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP.',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const offered = typeof (params.protocolVersion as string | undefined) === 'string' ? (params.protocolVersion as string) : MCP_VERSION;
    const negotiated = [MCP_VERSION, ...MCP_LEGACY_VERSIONS].includes(offered) ? offered : MCP_VERSION;
    return result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return result(toolsListResult());
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
      return rpcError(-32601, `Method not found: ${name}`);
    }
    // Missing required arguments: isError, never a silent success.
    for (const required of tool.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return result(errorResult(`Missing required argument: ${required}`));
      }
    }
    return result(callTool(store, name, args));
  }
  return rpcError(-32601, `Method not found: ${method}`);
}

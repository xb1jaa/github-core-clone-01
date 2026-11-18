// GitHub REST v3, as the suite drives it. Every reply is application/json
// with a non-empty X-GitHub-Request-Id; errors are {message}; auth is a
// Bearer token naming the viewer (any non-empty token is the viewer: the
// suite only ever sends its one token, or none).

import { commitFileOnBranch } from './gitproto.ts';
import {
  type Issue,
  type Pull,
  type Repo,
  type Store,
  VIEWER,
  commitHistory,
  createCommit,
  diffTrees,
  flattenTree,
  isOid,
  mergeBase,
  nowIso,
  nowSec,
  parseCommit,
  putObject,
  readDir,
  readPath,
  repoKey,
  tipTree,
  writePath,
} from './store.ts';

export interface RestContext {
  store: Store;
  requestId: () => string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

let requestCounter = 0;
export function newRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    assignees: [],
    assignee: null,
    comments: (repo.issueComments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: pull.user.login, id: pull.user.id, type: 'User' },
    labels: [],
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: { login: repo.owner, id: VIEWER.id }, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: { login: repo.owner, id: VIEWER.id }, repo: repoJson(repo) },
    merged: pull.merged,
    mergeable: pull.merged ? false : !pullConflicts(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** The GraphQL MergeableState string for an open pull request. */
export function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

/** True when the head and the base both changed a file differently vs the merge-base. */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseTree = base === null ? undefined : tipTree(repo, base);
  const headTree = tipTree(repo, pull.headSha);
  // The base side is the CURRENT base branch tip, not the sha the PR was
  // opened against: a merge that already landed changes what conflicts.
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const baseTipTree = tipTree(repo, currentBaseTip);
  const headChanges = new Map(diffTrees(repo, baseTree, headTree).map((c) => [c.path, c]));
  const baseChanges = new Map(diffTrees(repo, baseTree, baseTipTree).map((c) => [c.path, c]));
  for (const [path, headChange] of headChanges) {
    const baseChange = baseChanges.get(path);
    if (baseChange !== undefined && baseChange.newOid !== headChange.newOid) return true;
  }
  return false;
}

function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { items: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), totalPages };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string {
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${origin}${path}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${build(page + 1)}>; rel="next"`, `<${build(totalPages)}>; rel="last"`);
  if (page > 1) parts.push(`<${build(1)}>; rel="first"`, `<${build(page - 1)}>; rel="prev"`);
  return parts.join(', ');
}

/** Decode a percent-encoded path segment list (contents paths carry '/' inside). */
function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function handleRest(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown,
  authed: boolean,
  origin: string,
): RestResult {
  // The API root and meta need no repo; auth still applies to every /api/v3 call.
  if (!authed) return err(401, 'Requires authentication');
  const path = pathname.replace(/\/+$/, '') || '/';

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    return ok({ installed_version: '1.0.0' });
  }
  if (method === 'GET' && path === '/api/v3/user') {
    return ok({
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: `U_${VIEWER.id}`,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      html_url: `https://github.com/${VIEWER.login}`,
    });
  }
  if (method === 'GET' && path === '/api/v3/rate_limit') {
    return ok({ resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } }, rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } });
  }

  // POST /user/repos
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name : '';
    if (name === '') return err(422, 'Validation Failed: name is required');
    const repo = store.createRepo(name, typeof b.description === 'string' ? b.description : '', b.private === true);
    if (repo === null) return err(422, 'Validation Failed: name already exists on this account');
    return ok(repoJson(repo), 201);
  }

  // GET /user/repos (paginated)
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const { page, perPage } = parsePagination(query);
    const repos = store.viewerRepos();
    const { items, totalPages } = paginate(repos, page, perPage);
    const headers: Record<string, string> = {};
    const link = linkHeader(origin, pathname, query, page, perPage, totalPages);
    if (link !== '') headers.link = link;
    return ok(items.map(repoJson), 200, headers);
  }

  // /repos/{owner}/{repo}[/*]
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (repoMatch !== null) {
    const owner = decodeURIComponent(repoMatch[1]);
    const name = decodeURIComponent(repoMatch[2]);
    const rest = repoMatch[3] ?? '';
    // A repo under any owner other than the token owner is a 404, never a 403.
    if (owner !== VIEWER.login) return err(404, 'Not Found');
    const repo = store.getRepo(owner, name);
    if (repo === undefined) return err(404, 'Not Found');
    return handleRepoRoute(store, repo, method, rest, query, body, origin, pathname);
  }

  return err(404, 'Not Found');
}

function handleRepoRoute(
  store: Store,
  repo: Repo,
  method: string,
  rest: string,
  query: URLSearchParams,
  body: unknown,
  origin: string,
  pathname: string,
): RestResult {
  const b = (body ?? {}) as Record<string, unknown>;

  // GET /repos/{o}/{r}
  if (rest === '' && method === 'GET') return ok(repoJson(repo));
  // PATCH /repos/{o}/{r}
  if (rest === '' && method === 'PATCH') {
    if (typeof b.description === 'string') repo.description = b.description;
    repo.updatedAt = nowIso();
    return ok(repoJson(repo));
  }
  // DELETE /repos/{o}/{r}
  if (rest === '' && method === 'DELETE') {
    store.repos.delete(repoKey(repo.owner, repo.name));
    return { status: 204, body: null };
  }

  // POST /git/refs — create a branch (or tag) at a sha.
  if (rest === '/git/refs' && method === 'POST') {
    const ref = typeof b.ref === 'string' ? b.ref : '';
    const sha = typeof b.sha === 'string' ? b.sha : '';
    if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Validation Failed');
    if (repo.refs.has(ref)) return err(422, 'Validation Failed: Reference already exists');
    if (!repo.objects.has(sha)) return err(422, 'Validation Failed: Object does not exist');
    repo.refs.set(ref, sha);
    return ok({ ref, object: { sha, type: 'commit' } }, 201);
  }
  // GET /git/refs/heads/{branch}
  const singleRef = /^\/git\/refs\/(.+)$/.exec(rest);
  if (singleRef !== null && method === 'GET') {
    const ref = decodePath(singleRef[1]);
    const tip = repo.refs.get(ref);
    if (tip === undefined) return err(404, 'Not Found');
    return ok({ ref, object: { sha: tip, type: 'commit' } });
  }

  // GET /branches and GET /branches/{branch}
  if (rest === '/branches' && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .sort()
      .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r)! } }));
    return ok(branches);
  }
  const oneBranch = /^\/branches\/(.+)$/.exec(rest);
  if (oneBranch !== null && method === 'GET') {
    const ref = `refs/heads/${decodePath(oneBranch[1])}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return err(404, 'Not Found');
    return ok({ name: decodePath(oneBranch[1]), commit: { sha: tip } });
  }

  // GET /commits[?sha=ref]
  if (rest === '/commits' && method === 'GET') {
    const refParam = query.get('sha');
    let tip: string | undefined;
    if (refParam === null) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    } else if (repo.refs.has(`refs/heads/${refParam}`)) {
      tip = repo.refs.get(`refs/heads/${refParam}`);
    } else if (isOid(refParam) && repo.objects.has(refParam)) {
      tip = refParam;
    } else {
      return err(404, 'Not Found');
    }
    const commits = commitHistory(repo, tip).map((c) => {
      const obj = repo.objects.get(c.sha);
      const info = obj === undefined ? null : parseCommit(obj.data);
      return {
        sha: c.sha,
        commit: {
          message: c.message,
          author: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
          committer: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
          tree: { sha: info?.tree ?? '' },
        },
        parents: (info?.parents ?? []).map((p) => ({ sha: p })),
      };
    });
    return ok(commits);
  }

  // Contents: PUT /contents/{path}, GET /contents/{path}, DELETE /contents/{path}
  const contentsMatch = /^\/contents\/(.+)$/.exec(rest);
  if (contentsMatch !== null) {
    const filePath = decodePath(contentsMatch[1]);
    const branch = typeof query.get('ref') === 'string' && query.get('ref') !== null ? (query.get('ref') as string) : undefined;
    const refName = branch !== undefined && repo.refs.has(`refs/heads/${branch}`) ? `refs/heads/${branch}` : `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(refName);
    if (method === 'GET') {
      const tree = tipTree(repo, tip);
      const blobOid = readPath(repo, tree, filePath);
      if (blobOid !== null) {
        const blob = repo.objects.get(blobOid)!;
        return ok({
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: filePath.split('/').pop(),
          path: filePath,
          content: blob.data.toString('base64'),
          sha: blobOid,
        });
      }
      const dir = readDir(repo, tree, filePath);
      if (dir !== null) {
        return ok(
          dir.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: `${filePath}/${e.name}`,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          })),
        );
      }
      return err(404, 'Not Found');
    }
    if (method === 'PUT') {
      const message = typeof b.message === 'string' ? b.message : 'Update file';
      const contentB64 = typeof b.content === 'string' ? b.content : '';
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return err(422, 'Validation Failed: content is not valid base64');
      }
      const targetBranch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
      const targetRef = `refs/heads/${targetBranch}`;
      const targetTip = repo.refs.get(targetRef);
      const targetTree = tipTree(repo, targetTip);
      const currentOid = readPath(repo, targetTree, filePath);
      const givenSha = typeof b.sha === 'string' ? b.sha : undefined;
      if (givenSha !== undefined) {
        if (currentOid === null) return err(422, 'Validation Failed: file does not exist');
        if (givenSha.toLowerCase() !== currentOid.toLowerCase()) return err(409, 'Conflict: sha does not match');
      }
      const isNew = currentOid === null;
      const { commitSha, blobSha } = commitFileOnBranch(repo, targetBranch, filePath, content, message);
      repo.updatedAt = nowIso();
      return ok(
        { content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, encoding: 'base64' }, commit: { sha: commitSha, message } },
        isNew ? 201 : 200,
      );
    }
    if (method === 'DELETE') {
      const givenSha = typeof b.sha === 'string' ? b.sha : undefined;
      const message = typeof b.message === 'string' ? b.message : 'Delete file';
      const targetBranch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
      const targetRef = `refs/heads/${targetBranch}`;
      const targetTip = repo.refs.get(targetRef);
      const targetTree = tipTree(repo, targetTip);
      const currentOid = readPath(repo, targetTree, filePath);
      if (currentOid === null) return err(404, 'Not Found');
      if (givenSha !== undefined && givenSha.toLowerCase() !== currentOid.toLowerCase()) return err(409, 'Conflict: sha does not match');
      const { commitSha } = commitFileOnBranch(repo, targetBranch, filePath, null, message);
      repo.updatedAt = nowIso();
      return ok({ commit: { sha: commitSha, message } }, 200);
    }
  }

  // Labels
  if (rest === '/labels' && method === 'POST') {
    const name = typeof b.name === 'string' ? b.name : '';
    if (name === '') return err(422, 'Validation Failed: name is required');
    const color = typeof b.color === 'string' ? b.color : 'ededed';
    const existing = repo.labels.get(name);
    if (existing !== undefined) return ok({ name: existing.name, color: existing.color }, 201);
    repo.labels.set(name, { name, color });
    return ok({ name, color }, 201);
  }
  if (rest === '/labels' && method === 'GET') {
    return ok([...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
  }

  // Issues
  const issuesMatch = /^\/issues(\/(\d+)(\/comments)?)?$/.exec(rest);
  if (issuesMatch !== null) {
    const num = issuesMatch[2] === undefined ? null : Number(issuesMatch[2]);
    const isComments = issuesMatch[3] !== undefined;
    if (num === null && !isComments) {
      if (method === 'POST') {
        const title = typeof b.title === 'string' ? b.title : '';
        const bodyText = typeof b.body === 'string' ? b.body : '';
        if (title === '') return err(422, 'Validation Failed: title is required');
        const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
        }
        const stamp = nowIso();
        const number = repo.nextNumber++;
        const issue = {
          number,
          title,
          body: bodyText,
          state: 'open' as const,
          labels,
          user: VIEWER,
          createdAt: stamp,
          updatedAt: stamp,
          closedAt: null,
        };
        repo.issues.set(number, issue);
        repo.issueComments.set(number, []);
        return ok(issueJson(repo, issue), 201);
      }
      if (method === 'GET') {
        const { page, perPage } = parsePagination(query);
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        if (sort === 'created') list.sort((a, c) => (direction === 'asc' ? a.number - c.number : c.number - a.number));
        const { items, totalPages } = paginate(list, page, perPage);
        const headers: Record<string, string> = {};
        const link = linkHeader(origin, pathname, query, page, perPage, totalPages);
        if (link !== '') headers.link = link;
        return ok(items.map((i) => issueJson(repo, i)), 200, headers);
      }
    }
    if (num !== null && !isComments) {
      const issue = repo.issues.get(num);
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'GET') return ok(issueJson(repo, issue));
      if (method === 'PATCH') {
        const state = b.state;
        if (state === 'closed' || state === 'open') {
          issue.state = state;
          issue.closedAt = state === 'closed' ? nowIso() : null;
          issue.updatedAt = nowIso();
        }
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        return ok(issueJson(repo, issue));
      }
    }
    if (num !== null && isComments) {
      const issue = repo.issues.get(num);
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'POST') {
        const bodyText = typeof b.body === 'string' ? b.body : '';
        const stamp = nowIso();
        const comment = { id: repo.nextCommentId++, body: bodyText, user: VIEWER, createdAt: stamp, updatedAt: stamp };
        repo.issueComments.get(num)!.push(comment);
        return ok({ id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: stamp, updated_at: stamp }, 201);
      }
      if (method === 'GET') {
        return ok(
          (repo.issueComments.get(num) ?? []).map((c) => ({
            id: c.id,
            body: c.body,
            user: { login: c.user.login, id: c.user.id },
            created_at: c.createdAt,
            updated_at: c.updatedAt,
          })),
        );
      }
    }
  }

  // Pull requests
  const pullsMatch = /^\/pulls(\/(\d+)(\/(files|merge))?)?$/.exec(rest);
  if (pullsMatch !== null) {
    const num = pullsMatch[2] === undefined ? null : Number(pullsMatch[2]);
    const sub = pullsMatch[4];
    if (num === null) {
      if (method === 'POST') {
        const head = typeof b.head === 'string' ? b.head : '';
        const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
        const title = typeof b.title === 'string' ? b.title : '';
        const bodyText = typeof b.body === 'string' ? b.body : '';
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (headTip === undefined || baseTip === undefined) return err(422, 'Validation Failed: head or base branch does not exist');
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
        return ok(pullJson(repo, pull), 201);
      }
      if (method === 'GET') {
        const { page, perPage } = parsePagination(query);
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, c) => c.number - a.number);
        const { items, totalPages } = paginate(list, page, perPage);
        const headers: Record<string, string> = {};
        const link = linkHeader(origin, pathname, query, page, perPage, totalPages);
        if (link !== '') headers.link = link;
        return ok(items.map((p) => pullJson(repo, p)), 200, headers);
      }
    }
    if (num !== null) {
      const pull = repo.pulls.get(num);
      if (pull === undefined) return err(404, 'Not Found');
      if (sub === 'files' && method === 'GET') {
        const base = mergeBase(repo, pull.headSha, pull.baseSha);
        const baseTree = base === null ? undefined : tipTree(repo, base);
        const headTree = tipTree(repo, pull.headSha);
        const changes = diffTrees(repo, baseTree, headTree);
        return ok(
          changes.map((c) => ({
            filename: c.path,
            status: c.status === 'removed' ? 'removed' : c.status === 'added' ? 'added' : 'modified',
            additions: c.additions,
            deletions: c.deletions,
            changes: c.additions + c.deletions,
          })),
        );
      }
      if (sub === 'merge' && method === 'PUT') {
        if (pull.merged) return err(405, 'Pull Request is already merged');
        if (pull.state === 'closed') return err(405, 'Pull Request is closed');
        if (pullConflicts(repo, pull)) return err(405, 'Merge conflict');
        const mergeSha = doSquashMerge(repo, pull);
        return ok({ merged: true, sha: mergeSha, message: `Pull Request successfully merged` }, 200);
      }
      if (sub === undefined && method === 'GET') return ok(pullJson(repo, pull));
      if (sub === undefined && method === 'PATCH') {
        if (b.state === 'closed' || b.state === 'open') {
          pull.state = b.state as 'open' | 'closed';
          pull.closedAt = b.state === 'closed' ? nowIso() : null;
          pull.updatedAt = nowIso();
        }
        return ok(pullJson(repo, pull));
      }
    }
  }

  return err(404, 'Not Found');
}

/** Squash-merge a pull request: one commit on the base branch carrying the
 * head's changes, the PR marked merged and closed. Returns the merge sha. */
export function doSquashMerge(repo: Repo, pull: Pull): string {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseTree = base === null ? undefined : tipTree(repo, base);
  const headTree = tipTree(repo, pull.headSha);
  // Squash onto the CURRENT base branch tip, not the sha the PR opened against.
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const baseTipTree = tipTree(repo, currentBaseTip);
  const headChanges = diffTrees(repo, baseTree, headTree);
  let mergedTree = baseTipTree;
  for (const change of headChanges) {
    mergedTree = writePath(repo, mergedTree, change.path, change.newOid);
  }
  const mergeSha = createCommit(
    repo,
    mergedTree ?? putObject(repo, 'tree', Buffer.alloc(0)),
    [currentBaseTip],
    `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`,
    nowSec(),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.state = 'closed';
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = nowIso();
  repo.updatedAt = nowIso();
  return mergeSha;
}

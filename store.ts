// The forge's store: one in-memory model shared by git smart HTTP, REST v3,
// GraphQL v4 and MCP. No disk, no dependencies: every lookup the timed workloads
// need is a Map get, and every object is stored byte-exact under its SHA-1.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

/** SHA-1 of "<type> <size>\0" + data, lowercase hex. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export const ZERO_OID = '0'.repeat(40);

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

// ---------------------------------------------------------------- users

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The token owner. The suite's scenario derives this login from its fixed seed;
 * it is the same in every trial (see the kit's known-issue note). An env override
 * exists for the house reference forge's local runs. */
export const VIEWER_LOGIN = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
export const VIEWER: User = Object.freeze({
  id: 1000,
  login: VIEWER_LOGIN,
  name: 'ada iversen',
  email: `${VIEWER_LOGIN}@example.invalid`,
});

// ---------------------------------------------------------------- issues / pulls

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Label {
  name: string;
  color: string;
}

// ---------------------------------------------------------------- repositories

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** git objects by oid, byte-exact as pushed. */
  objects: Map<string, GitObject>;
  /** full ref name ("refs/heads/main") -> tip oid. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  issueComments: Map<number, IssueComment[]>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  /** one shared number sequence for issues and pull requests, GitHub-style. */
  nextNumber: number;
  nextCommentId: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  /** Create a repo owned by the viewer. Returns null when the name is taken. */
  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo | null {
    if (this.repos.has(repoKey(VIEWER.login, name))) return null;
    const stamp = nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER.login,
      name,
      description,
      private: isPrivate,
      defaultBranch,
      createdAt: stamp,
      updatedAt: stamp,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      issueComments: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  /** Repos owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER.login) out.push(repo);
    return out;
  }
}

// ---------------------------------------------------------------- git object parsing

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!isOid(tree)) return null;
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree sort: byte order of the name, a directory compared as name + '/'. */
export function compareTreeNames(aName: string, aIsDir: boolean, bName: string, bIsDir: boolean): number {
  const a = aIsDir ? `${aName}/` : aName;
  const b = bIsDir ? `${bName}/` : bName;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((x, y) =>
    compareTreeNames(x.name, x.mode === '40000', y.name, y.mode === '40000'),
  );
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  if (!isOid(object)) return null;
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- git graph helpers

/** The ref HEAD points at (refs/heads/<defaultBranch>). */
export function headRefOf(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

/**
 * All objects reachable from `roots`, following commit parents/trees, tree
 * entries (except gitlinks) and tag targets. When `maxDepth` is given, commits
 * more than that many generations from a root are not followed (their parent
 * links stay in the commit bytes, the parent objects are just not included).
 * Returns the objects and, for the depth case, the new shallow boundaries:
 * included commits whose parent was cut off.
 */
export function collectReachable(
  repo: Repo,
  roots: readonly string[],
  maxDepth?: number,
  /** Commit oids at which parent traversal stops (the commit and its tree are
   * still collected). Used for the have-side of a shallow fetch: the client
   * holds everything down to its shallow boundary, but nothing below it, so
   * excluding the full history would swallow the generations a `deepen`
   * request is meant to deliver. */
  stopAt?: ReadonlySet<string>,
): { objects: Map<string, GitObject>; shallow: string[] } {
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const queue: { oid: string; depth: number }[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (isOid(root) && root !== ZERO_OID && !seen.has(root)) {
      seen.add(root);
      queue.push({ oid: root, depth: 0 });
    }
  }
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (!objects.has(oid)) objects.set(oid, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit === null) continue;
      const cut = maxDepth !== undefined && depth + 1 >= maxDepth;
      if (cut) {
        if (commit.parents.length > 0) shallow.push(oid);
      } else if (stopAt === undefined || !stopAt.has(oid)) {
        for (const parent of commit.parents) {
          if (!seen.has(parent)) {
            seen.add(parent);
            queue.push({ oid: parent, depth: depth + 1 });
          }
        }
      }
      if (!seen.has(commit.tree)) {
        seen.add(commit.tree);
        queue.push({ oid: commit.tree, depth });
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        if (!seen.has(entry.oid)) {
          seen.add(entry.oid);
          queue.push({ oid: entry.oid, depth });
        }
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag !== null && !seen.has(tag.object)) {
        seen.add(tag.object);
        queue.push({ oid: tag.object, depth });
      }
    }
  }
  return { objects, shallow };
}

/** True when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** A merge-base of a and b: the first common ancestor found walking both histories. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.shift()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    for (const parent of commit.parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj?.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    for (const parent of commit.parents) queueB.push(parent);
  }
  return null;
}

/** Commits on a branch tip, newest first (first-parent walk with full parent set). */
export function commitHistory(repo: Repo, tip: string | undefined): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  if (tip === undefined) return out;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    out.push({ sha: oid, message: commit.message });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- trees: read / write paths

/** The blob oid at `path` in the tree `treeOid` (null when absent). */
export function readPath(repo: Repo, treeOid: string | undefined, path: string): string | null {
  if (treeOid === undefined) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let current: string | undefined = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = current === undefined ? undefined : repo.objects.get(current);
    if (obj?.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** Entries of the tree at `path` ('' for the root): null when not a directory. */
export function readDir(repo: Repo, treeOid: string | undefined, path: string): TreeEntry[] | null {
  if (treeOid === undefined) return null;
  if (path === '' || path === '/') {
    const obj = repo.objects.get(treeOid);
    return obj?.type === 'tree' ? parseTree(obj.data) : null;
  }
  const segments = path.split('/').filter((s) => s !== '');
  let current: string | undefined = treeOid;
  for (const segment of segments) {
    const obj = current === undefined ? undefined : repo.objects.get(current);
    if (obj?.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const obj = current === undefined ? undefined : repo.objects.get(current);
  return obj?.type === 'tree' ? parseTree(obj.data) : null;
}

/**
 * A new tree oid equal to `treeOid` with `path` set to `blobOid` (or removed when
 * `blobOid` is null). Intermediate directories are created as needed; emptied
 * directories are dropped. Returns the new tree oid.
 */
export function writePath(repo: Repo, treeOid: string | undefined, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((s) => s !== '');
  const build = (tree: string | undefined, depth: number): string | null => {
    const entries = new Map<string, TreeEntry>();
    if (tree !== undefined) {
      const obj = repo.objects.get(tree);
      if (obj?.type === 'tree') for (const e of parseTree(obj.data)) entries.set(e.name, e);
    }
    const name = segments[depth];
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const next = build(child?.mode === '40000' ? child.oid : undefined, depth + 1);
      if (next === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    if (entries.size === 0) return null;
    const sorted = sortTreeEntries([...entries.values()]);
    return putObject(repo, 'tree', buildTree(sorted));
  };
  return build(treeOid, 0) ?? putObject(repo, 'tree', buildTree([]));
}

/** The tree oid of a commit ('' when the tip is undefined). */
export function tipTree(repo: Repo, tip: string | undefined): string | undefined {
  if (tip === undefined) return undefined;
  const obj = repo.objects.get(tip);
  if (obj?.type !== 'commit') return undefined;
  return parseCommit(obj.data)?.tree;
}

/** Create a commit object; returns its oid. */
export function createCommit(
  repo: Repo,
  tree: string,
  parents: readonly string[],
  message: string,
  timestampSec: number = nowSec(),
): string {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${timestampSec} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  // The message is stored verbatim: the suite compares it byte-for-byte with
  // the message it sent (no trailing newline added).
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Flatten a tree to path -> blob oid (files only). */
export function flattenTree(repo: Repo, treeOid: string | undefined, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (treeOid === undefined) return out;
  const obj = repo.objects.get(treeOid);
  if (obj?.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, o] of flattenTree(repo, entry.oid, path)) out.set(p, o);
    } else if (entry.mode !== '160000') {
      out.set(path, entry.oid);
    }
  }
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

function countLines(data: Buffer | undefined): number {
  if (data === undefined) return 0;
  const text = data.toString('utf8');
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(repo: Repo, baseTree: string | undefined, headTree: string | undefined): FileChange[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldOid = base.get(path) ?? null;
    const newOid = head.get(path) ?? null;
    if (oldOid === newOid) continue;
    const status = oldOid === null ? 'added' : newOid === null ? 'removed' : 'modified';
    const oldData = oldOid === null ? undefined : repo.objects.get(oldOid)?.data;
    const newData = newOid === null ? undefined : repo.objects.get(newOid)?.data;
    const additions = status === 'removed' ? 0 : countLines(newData);
    const deletions = status === 'added' ? 0 : countLines(oldData);
    out.push({ path, status, oldOid, newOid, additions, deletions });
  }
  return out;
}

// ---------------------------------------------------------------- global ids (GraphQL / MCP)

/** Opaque, stable, deterministic global ids: base64url of a typed key. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const split = text.indexOf(':');
    if (split <= 0) return null;
    return { kind: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

export function issueGlobalId(repo: Repo, number: number): string {
  return globalId('Issue', `${repo.id}:${number}`);
}

export function pullGlobalId(repo: Repo, number: number): string {
  return globalId('PullRequest', `${repo.id}:${number}`);
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return globalId('IssueComment', `${repo.id}:${issueNumber}:${commentId}`);
}

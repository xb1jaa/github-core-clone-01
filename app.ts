// The forge's HTTP server: routing, auth, body handling. One process, no
// dependencies, in-memory store. Kept thin: each surface lives in its own
// module (gitproto.ts, rest.ts, graphql.ts, mcp.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, newRequestId } from './rest.ts';
import { Store, VIEWER } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': newRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': newRequestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 64 * 1024 * 1024) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^Bearer\s+\S+$/.test(header);
}

export function createApp(): Server {
  const store = new Store();
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await dispatch(store, req, res);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.destroy();
      }
    }
  });
}

async function dispatch(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pathname = url.pathname;
  const query = url.searchParams;
  const authed = bearerAuthed(req);
  const origin = `http://${req.headers.host ?? 'entry'}`;

  // Boot probe: no auth.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authed) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
      return;
    }
    const out = handleGraphQL(store, parsed);
    sendJson(res, out.status, out.body);
    return;
  }

  // MCP over streamable HTTP.
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      // Session teardown: best-effort, always accepted.
      res.writeHead(202, { 'x-github-request-id': newRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const out = handleMcp(store, raw, authed);
    if (out.status === 202 || out.body === null) {
      res.writeHead(202, { 'x-github-request-id': newRequestId() });
      res.end();
      return;
    }
    sendJson(res, out.status, out.body);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    let parsed: unknown = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    const out = handleRest(store, method, pathname, query, parsed, authed, origin);
    if (out.status === 204) {
      res.writeHead(204, { 'x-github-request-id': newRequestId(), ...out.headers });
      res.end();
      return;
    }
    sendJson(res, out.status, out.body, out.headers);
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
  const gitMatch = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = gitMatch[1];
    const name = gitMatch[2];
    const action = gitMatch[3];
    // A repo under any owner other than the token owner is a 404, never a 403.
    const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
    if (action === 'info/refs' && method === 'GET') {
      const service = query.get('service') ?? '';
      const out = handleInfoRefs(repo, service, req.headers['git-protocol'] ?? '');
      sendBytes(res, out.status, out.body, out.contentType);
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      const raw = await readBody(req);
      const out = handleUploadPack(repo, raw, req.headers['git-protocol'] ?? '');
      sendBytes(res, out.status, out.body, out.contentType);
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      const out = handleReceivePack(repo, raw);
      sendBytes(res, out.status, out.body, out.contentType);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Anything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}

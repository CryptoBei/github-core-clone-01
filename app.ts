// The HTTP surface: one server, four mounted services — git smart HTTP at
// /{owner}/{repo}.git, REST v3 at /api/v3, GraphQL at /api/graphql, MCP at /mcp — plus
// /healthz. Everything except /healthz requires a non-empty Bearer token. Every reply is
// JSON (or a git payload) with a non-empty X-GitHub-Request-Id; a handler error answers
// 500 JSON instead of ever taking the process down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack, nextRequestId } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (!header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length).trim().length > 0;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!rejected) {
        rejected = true;
        reject(err);
      }
    });
  });
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  let pathname: string;
  let query: URLSearchParams;
  try {
    const url = new URL(rawUrl, 'http://local');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    sendJson(res, 400, { message: 'Bad request' });
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!hasAuth(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // ---- git smart HTTP -----------------------------------------------------
  const gitMatch = GIT_PATH.exec(pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repo = decodeURIComponent(gitMatch[2]);
    const tail = gitMatch[3] ?? '';
    if (method === 'GET' && tail === '/info/refs') {
      handleInfoRefs(req, res, owner, repo, query.get('service'));
      return;
    }
    if (method === 'POST' && tail === '/git-upload-pack') {
      const body = await readBody(req);
      handleUploadPack(req, res, owner, repo, body);
      return;
    }
    if (method === 'POST' && tail === '/git-receive-pack') {
      const body = await readBody(req);
      handleReceivePack(req, res, owner, repo, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- REST v3 ------------------------------------------------------------
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    const restPath = pathname.slice('/api/v3'.length);
    const segments = restPath.split('/').filter((part) => part.length > 0).map((part) => decodeURIComponent(part));
    handleRest({ req, res, segments, query, body });
    return;
  }

  // ---- GraphQL ------------------------------------------------------------
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    handleGraphQL(req, res, body);
    return;
  }

  // ---- MCP ----------------------------------------------------------------
  if (pathname === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    handleMcp(req, res, raw);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

let crashGuardInstalled = false;

export function createApp(): Server {
  if (!crashGuardInstalled) {
    crashGuardInstalled = true;
    // A bug in a handler must never kill the run: log and carry on serving.
    process.on('uncaughtException', (err) => {
      console.error('[forge] uncaught exception (continuing):', err);
    });
    process.on('unhandledRejection', (err) => {
      console.error('[forge] unhandled rejection (continuing):', err);
    });
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[forge] request error:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });
  server.on('clientError', (err, socket) => {
    console.error('[forge] client error:', err);
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"message":"Bad Request"}');
  });
  return server;
}

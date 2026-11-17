// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and
// pull requests. Every reply is application/json with a non-empty X-GitHub-Request-Id; errors
// carry a JSON {message}. Auth is enforced by the router before this module runs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, getRepo, repos, type Repo } from './store.ts';
import {
  addCommentOp,
  branchJson,
  branchTip,
  commentJson,
  contentsDeleteOp,
  contentsGetOp,
  contentsPutOp,
  createBranchOp,
  createIssueOp,
  createLabelOp,
  createPullOp,
  createRepoOp,
  deleteRepoOp,
  issueJsonObject,
  issueJsonString,
  labelJson,
  listCommits,
  mergePullOp,
  patchIssueOp,
  pullFiles,
  pullJson,
  repoJson,
} from './ops.ts';
import { nextRequestId, sendJson } from './githttp.ts';

export interface RestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (null when there is none). */
  body: unknown;
}

function sendRawJson(res: ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function failOp(res: ServerResponse, result: { ok: false; error: string; status: number }): void {
  sendJson(res, result.status, { message: result.error });
}

function bodyObject(ctx: RestContext): Record<string, unknown> {
  return ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body)
    ? (ctx.body as Record<string, unknown>)
    : {};
}

function pageParams(ctx: RestContext): { perPage: number; page: number } {
  const perPageRaw = Number(ctx.query.get('per_page'));
  const pageRaw = Number(ctx.query.get('page'));
  const perPage = Number.isInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], ctx: RestContext): { page: T[]; link: string | null; total: number } {
  const { perPage, page } = pageParams(ctx);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = ctx.req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${ctx.req.url?.split('?')[0] ?? ''}`;
  const linkFor = (p: number): string => `${base}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (start + slice.length < total) links.push(`<${linkFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${linkFor(page - 1)}>; rel="prev"`);
  links.push(`<${linkFor(1)}>; rel="first"`);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  links.push(`<${linkFor(lastPage)}>; rel="last"`);
  return { page: slice, link: links.join(', '), total };
}

function sendPage(res: ServerResponse, items: unknown[], link: string | null): void {
  sendJson(res, 200, items, link === null ? {} : { link });
}

/** The repository a /repos/{owner}/{name} route names (null when missing or foreign-owned). */
function repoOf(ctx: RestContext): Repo | null {
  const owner = ctx.segments[1] as string;
  const name = ctx.segments[2] as string;
  return getRepo(owner, name);
}

export function handleRest(ctx: RestContext): void {
  const { req, res, segments } = ctx;
  const method = req.method ?? 'GET';

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    notFound(res);
    return;
  }

  // GET /api/v3/meta
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
      return;
    }
    notFound(res);
    return;
  }

  // GET /api/v3/user
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
      });
      return;
    }
    notFound(res);
    return;
  }

  // /api/v3/user/repos
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const result = createRepoOp(VIEWER.login, bodyObject(ctx));
      if (!result.ok) {
        failOp(res, result);
        return;
      }
      sendJson(res, 201, repoJson(result.value));
      return;
    }
    if (method === 'GET') {
      const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER.login);
      const { page, link } = paginate(mine, ctx);
      sendPage(res, page.map(repoJson), link);
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    notFound(res);
    return;
  }

  const repo = repoOf(ctx);
  if (repo === null) {
    notFound(res);
    return;
  }
  const tail = segments.slice(3);

  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepoOp(repo);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  const head = tail[0] as string;

  // Branches
  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, oid] of repo.refs) {
        if (ref.startsWith('refs/heads/')) branches.push(branchJson(ref.slice('refs/heads/'.length), oid));
      }
      branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sendJson(res, 200, branches);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const tip = branchTip(repo, tail[1] as string);
      if (tip === null) {
        notFound(res);
        return;
      }
      sendJson(res, 200, branchJson(tail[1] as string, tip));
      return;
    }
    notFound(res);
    return;
  }

  // Commits
  if (head === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const result = listCommits(repo, ctx.query.get('sha'));
      if (!result.ok) {
        failOp(res, result);
        return;
      }
      sendJson(res, 200, result.value);
      return;
    }
    notFound(res);
    return;
  }

  // Git refs
  if (head === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const result = createBranchOp(repo, bodyObject(ctx));
      if (!result.ok) {
        failOp(res, result);
        return;
      }
      sendJson(res, 201, { ref: result.value.ref, object: { sha: result.value.sha } });
      return;
    }
    if (tail.length === 4 && method === 'GET' && (tail[2] === 'heads' || tail[2] === 'tags')) {
      const ref = `refs/${tail[2]}/${tail[3]}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref, object: { sha: oid } });
      return;
    }
    notFound(res);
    return;
  }

  // Contents
  if (head === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const result = contentsGetOp(repo, path, ctx.query.get('ref'));
      if (!result.ok) {
        failOp(res, result);
        return;
      }
      const value = result.value;
      if (value.kind === 'dir') {
        sendJson(res, 200, value.entries);
        return;
      }
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: value.content.toString('base64'),
        sha: value.sha,
        size: value.size,
        name: value.name,
        path: value.path,
      });
      return;
    }
    if (method === 'PUT') {
      const result = contentsPutOp(repo, path, bodyObject(ctx));
      if (!result.ok) {
        failOp(res, result);
        return;
      }
      const value = result.value;
      sendJson(res, value.status, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: value.contentSha,
          size: value.size,
          encoding: 'base64',
          type: 'file',
        },
        commit: { sha: value.commitSha, message: typeof bodyObject(ctx).message === 'string' ? bodyObject(ctx).message : '' },
      });
      return;
    }
    if (method === 'DELETE') {
      const result = contentsDeleteOp(repo, path, bodyObject(ctx));
      if (!result.ok) {
        failOp(res, result);
        return;
      }
      sendJson(res, 200, { commit: { sha: result.value.commitSha } });
      return;
    }
    notFound(res);
    return;
  }

  // Labels
  if (head === 'labels') {
    if (tail.length === 1 && method === 'POST') {
      const result = createLabelOp(repo, bodyObject(ctx));
      if (!result.ok) {
        failOp(res, result);
        return;
      }
      sendJson(res, 201, labelJson(result.value));
      return;
    }
    if (tail.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
    notFound(res);
    return;
  }

  // Issues
  if (head === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const result = createIssueOp(repo, bodyObject(ctx));
        if (!result.ok) {
          failOp(res, result);
          return;
        }
        sendJson(res, 201, issueJsonObject(repo, result.value));
        return;
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page, link } = paginate(list, ctx);
        sendPage(res, page.map((issue) => issueJsonObject(repo, issue)), link);
        return;
      }
      notFound(res);
      return;
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) {
      notFound(res);
      return;
    }
    const issue = repo.issues.get(number);
    if (issue === undefined) {
      notFound(res);
      return;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        // The cached serialized form: the read workload's fast path.
        sendRawJson(res, 200, issueJsonString(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const result = patchIssueOp(repo, issue, bodyObject(ctx));
        if (!result.ok) {
          failOp(res, result);
          return;
        }
        sendJson(res, 200, issueJsonObject(repo, result.value));
        return;
      }
      notFound(res);
      return;
    }
    if (tail[2] === 'comments') {
      if (method === 'POST') {
        const body = bodyObject(ctx);
        if (typeof body.body !== 'string') {
          badRequest(res, 'body is required');
          return;
        }
        const result = addCommentOp(repo, issue, body.body);
        if (!result.ok) {
          failOp(res, result);
          return;
        }
        sendJson(res, 201, commentJson(result.value));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map(commentJson));
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }

  // Pull requests
  if (head === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const result = createPullOp(repo, bodyObject(ctx));
        if (!result.ok) {
          failOp(res, result);
          return;
        }
        sendJson(res, 201, pullJson(repo, result.value));
        return;
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        const { page, link } = paginate(list, ctx);
        sendPage(res, page.map((pull) => pullJson(repo, pull)), link);
        return;
      }
      notFound(res);
      return;
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) {
      notFound(res);
      return;
    }
    const pull = repo.pulls.get(number);
    if (pull === undefined) {
      notFound(res);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      sendJson(res, 200, pullFiles(repo, pull));
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const result = mergePullOp(repo, pull);
      if (!result.ok) {
        failOp(res, result);
        return;
      }
      sendJson(res, 200, { sha: result.value.sha, merged: true, message: result.value.message });
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

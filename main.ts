// Entry point: the lifecycle that ties this forge to the trial harness.
//
// The harness (the "env") owns port 8080 and drives the whole trial. This
// process has three jobs only: start the forge on a kernel-chosen port, tell
// the env where it is, and stay alive until the env says the trial is over.
// Nothing here reaches past the env, and nothing here calls a model: the
// forge serves the suite from its own store.

import { createApp } from './app.ts';

// One request may take this long before it is abandoned and retried.
const REQUEST_TIMEOUT_MS = 30_000;
// First pause between retries; each retry doubles it up to the cap.
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;
// Responses that mean "you are registered".
const REGISTERED_STATUSES = new Set([200, 409]);
// Responses that mean the request itself breaks the contract: retrying
// cannot help, so they are fatal.
const FATAL_REGISTER_STATUSES = new Set([400, 405]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff with a ceiling: 250ms, 500ms, 1s, 2s, 2s, ...
function nextPause(currentMs: number): number {
  return Math.min(currentMs * 2, MAX_RETRY_MS);
}

// The env origin, without trailing slashes so paths join cleanly. The trial
// always sets MAKEFUN_ENV_URL; without it there is no harness to talk to.
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const origin = raw.replace(/\/+$/, '');
  if (origin === '') {
    console.error('main: MAKEFUN_ENV_URL is not set; nothing to register with');
    process.exit(1);
  }
  return origin;
}

// Start the forge on an ephemeral port and report the port the kernel picked.
// Port 0 is deliberate: 8080 belongs to the env.
function bindForge(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createApp();
  return new Promise((resolve, reject) => {
    const onBindError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onBindError);
    server.listen(0, () => {
      server.removeListener('error', onBindError);
      // From here on a server error is logged, never fatal: the forge must
      // keep serving until the env says the trial is over.
      server.on('error', (err) => {
        console.error('main: forge server error (continuing):', err);
      });
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        server.close();
        reject(new Error('main: forge bound to an unexpected address'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// POST {"port": <port>} to <env>/register until the env accepts it. A lost
// reply is indistinguishable from a lost request, so every failure is
// retried — except a 400/405, which says the request itself is wrong.
async function registerWithEnv(origin: string, port: number): Promise<void> {
  let pauseMs = FIRST_RETRY_MS;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(
        'main: register failed; retrying:',
        err instanceof Error ? err.message : err,
      );
      await sleep(pauseMs);
      pauseMs = nextPause(pauseMs);
      continue;
    }
    if (REGISTERED_STATUSES.has(res.status)) return;
    if (FATAL_REGISTER_STATUSES.has(res.status)) {
      throw new Error(`main: env rejected registration with HTTP ${res.status}`);
    }
    console.error(`main: register got HTTP ${res.status}; retrying`);
    await sleep(pauseMs);
    pauseMs = nextPause(pauseMs);
  }
}

// GET <env>/done until the env reports the trial finished. This never gives
// up: a failed poll only means "ask again later".
async function waitForTrialEnd(origin: string): Promise<void> {
  let pauseMs = FIRST_RETRY_MS;
  for (;;) {
    try {
      const res = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json()) as { done?: unknown };
      if (body !== null && typeof body === 'object' && body.done === true) return;
    } catch (err) {
      console.error(
        'main: done poll failed; retrying:',
        err instanceof Error ? err.message : err,
      );
    }
    await sleep(pauseMs);
    pauseMs = nextPause(pauseMs);
  }
}

async function main(): Promise<void> {
  const origin = envOrigin();
  const forge = await bindForge();
  try {
    await registerWithEnv(origin, forge.port);
    await waitForTrialEnd(origin);
  } finally {
    await forge.close();
  }
}

main().catch((err: unknown) => {
  console.error('main: fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

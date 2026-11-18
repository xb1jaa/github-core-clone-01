// main.ts — entrypoint for the github-core-clone forge.
//
// This file owns only the trial lifecycle, in this order:
//   1. Read the trial environment's base URL from MAKEFUN_ENV_URL.
//      If it is unset there is nothing to register with, so exit 1 at once.
//   2. Start the forge (createApp) and let the kernel pick an ephemeral port.
//   3. Tell the environment which port we took, at $MAKEFUN_ENV_URL/register.
//   4. Poll GET $MAKEFUN_ENV_URL/done until the suite answers {"done": true}.
//   5. Close the forge and exit 0.
//
// All of the forge itself — routing, git, REST, GraphQL, MCP, the store —
// lives in app.ts and its modules. Nothing here touches a request or a row.
//
// A local-check convenience: FORGE_PORT, when set to a valid port number,
// pins the listen port instead of letting the kernel choose. The trial never
// sets it, so a graded run always binds port 0. It exists only so the kit's
// conformance suite can be run against a known local port.

import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A doubling pause that stops growing at a cap. Failures stretch the pause;
 * a successful answer resets it, so a healthy poll stays on the short beat.
 */
class Backoff {
  private pauseMs: number;
  private readonly firstMs: number;
  private readonly capMs: number;

  constructor(firstMs: number, capMs: number) {
    this.firstMs = firstMs;
    this.capMs = capMs;
    this.pauseMs = firstMs;
  }

  current(): number {
    return this.pauseMs;
  }

  stretch(): void {
    this.pauseMs = Math.min(this.capMs, this.pauseMs * 2);
  }

  reset(): void {
    this.pauseMs = this.firstMs;
  }
}

/** A fatal disagreement with the environment: retrying would not help. */
class ContractError extends Error {}

/**
 * The environment's base URL, without a trailing slash. Exits 1 at once when
 * MAKEFUN_ENV_URL is unset or blank — there is no trial to join.
 */
function envBaseUrl(): string {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
  if (raw === '') {
    console.error('main: MAKEFUN_ENV_URL is not set; nothing to register with');
    process.exit(1);
  }
  return raw;
}

/**
 * The port to listen on: the FORGE_PORT override for local checks, else 0 so
 * the kernel picks an ephemeral port (never 8080 — the suite owns it).
 */
function listenPort(): number {
  const override = process.env.FORGE_PORT;
  if (override !== undefined && override !== '') {
    const n = Number(override);
    if (Number.isInteger(n) && n > 0 && n < 65536) {
      return n;
    }
    console.error(`main: ignoring invalid FORGE_PORT=${JSON.stringify(override)}`);
  }
  return 0;
}

/** Start the forge and report the port it actually bound. */
function startForge(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onError);
    server.listen(listenPort(), '0.0.0.0', () => {
      server.removeListener('error', onError);
      server.on('error', (err: Error) => {
        console.error(`main: forge server error: ${err.message}`);
        process.exit(1);
      });
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

/**
 * Announce our port to the environment. 200 means registered; 409 means
 * another entry registered first and is not an error. 400/405 are contract
 * errors and end the program. Anything else — a refused connection, a 5xx,
 * a timeout — is transient and retried on a stretching backoff.
 */
async function registerPort(base: string, port: number): Promise<void> {
  const wait = new Backoff(100, 5000);
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error(
        `main: register attempt failed (${err instanceof Error ? err.message : err}); retrying in ${wait.current()} ms`,
      );
      await sleep(wait.current());
      wait.stretch();
      continue;
    }
    if (res.status === 200 || res.status === 409) {
      console.log(`main: registered port ${port} (HTTP ${res.status})`);
      return;
    }
    if (res.status === 400 || res.status === 405) {
      throw new ContractError(`register refused with HTTP ${res.status}; the wire contract changed`);
    }
    console.error(`main: register answered HTTP ${res.status}; retrying in ${wait.current()} ms`);
    await sleep(wait.current());
    wait.stretch();
  }
}

/**
 * Poll the environment until the trial is over. The endpoint answers at
 * once, so poll on a short beat; a failed poll stretches the beat until the
 * next answer succeeds, then the beat resets to short.
 */
async function waitForDone(base: string): Promise<void> {
  const wait = new Backoff(200, 2000);
  for (;;) {
    let body: unknown;
    try {
      const res = await fetch(`${base}/done`, { signal: AbortSignal.timeout(10_000) });
      body = await res.json();
    } catch (err) {
      console.error(
        `main: /done poll failed (${err instanceof Error ? err.message : err}); retrying in ${wait.current()} ms`,
      );
      await sleep(wait.current());
      wait.stretch();
      continue;
    }
    const done =
      typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;
    if (done) {
      console.log('main: suite reports done; shutting down');
      return;
    }
    wait.reset();
    await sleep(wait.current());
  }
}

/** Stop the forge on SIGINT/SIGTERM instead of dying mid-request. */
function installSignalHandlers(server: ReturnType<typeof createApp>): void {
  const stop = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function main(): Promise<void> {
  const base = envBaseUrl();
  const { server, port } = await startForge();
  installSignalHandlers(server);
  console.log(`main: forge listening on port ${port}`);
  await registerPort(base, port);
  await waitForDone(base);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  console.log('main: forge stopped');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`main: fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);

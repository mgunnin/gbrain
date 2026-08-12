/**
 * hook-under-live-serve + lock-contention pins (agent-bootstrap plan [A7],
 * hook-under-serve + lock-contention — the PERMANENT pins the reviews
 * mandated).
 *
 * A REAL `gbrain serve` subprocess (bun src/cli.ts serve) runs against a
 * temp PGLite brain under a sandboxed GBRAIN_HOME while the in-process hook
 * command exercises the stdin→IPC→stdout contract:
 *
 *   Pin 1 — `runHook(['user-prompt'])` with a live serve holding the PGLite
 *           single-writer lock: exit 0 AND (non-empty additionalContext JSON
 *           OR a documented degradation reason in the heartbeat). Never a
 *           wiring-broken reason (no_serve / no_pglite_path / stale_serve).
 *   Pin 2 — the hook path NEVER touches the PGLite lock: runHook completes
 *           without LiveServeLockError while a direct engine open
 *           (createEngine + connect — the narrowest engine-open helper) DOES
 *           throw LiveServeLockError, proving the lock is really held.
 *   Pin 3 — stale serve: SIGKILL the serve, leave the socket file behind →
 *           the hook fails open (exit 0, empty stdout) with an
 *           ipc_unavailable/no_serve-class degradation.
 *
 * Serial: spawns a subprocess + cold PGLite init; explicit timeouts
 * everywhere; the serve child is killed in afterAll no matter what.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runHook, readHeartbeatTail } from '../../src/commands/hook.ts';
import { resolveSocketPath, ipcSecretPath } from '../../src/core/context/resolve-ipc.ts';
import { LiveServeLockError } from '../../src/core/pglite-lock.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { addSource } from '../../src/core/sources-ops.ts';
import {
  loadCorpusPages,
  loadCorpusBeliefs,
  loadCorpusBeliefData,
  loadCorpusQueries,
} from '../helpers/bootstrap-corpus.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const TRANSCRIPT_FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'conversation-formats', 'claude-code.jsonl');

/**
 * Documented degradation reasons for a hook running against a LIVE serve
 * (hook.ts heartbeat codes; latency-shaped entries mirror the non-gating set
 * verify.ts accepts). Anything OUTSIDE this set under a live serve means the
 * wiring is broken and the pin must fail.
 */
const DOCUMENTED_LIVE_SERVE_REASONS = new Set([
  'empty_block', // plumbing works, brain has nothing to volunteer yet
  'empty_window', // nothing to send (shouldn't happen here, but documented)
  'deadline', // 800ms self-deadline on a slow box — designed fail-open
  'server_budget', // serve's 400ms assembly budget — designed fail-open
  'ipc_unavailable', // client timeout under load — designed fail-open
  'over_cap', // block trimmed to nothing under the 10000-char harness cap
]);

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_SWEEP', 'GBRAIN_BOOTSTRAP_ABORT_AFTER',
];

// Short prefix — the IPC unix socket lives under database_path and socket
// paths cap out around 104 bytes on macOS.
let tmpParent: string;
let home: string;
let dbDir: string;
let ws: string;
let serveProc: ReturnType<typeof Bun.spawn> | null = null;
const serveStderr: string[] = [];

function collectStdout(): { write: (s: string) => void; get: () => string } {
  let buf = '';
  return { write: (s: string) => { buf += s; }, get: () => buf };
}

async function pollFor(pred: () => boolean, deadlineMs: number, label: string): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    if (serveProc && serveProc.exitCode !== null) {
      throw new Error(
        `serve exited early (code ${serveProc.exitCode}) while waiting for ${label}\nstderr:\n${serveStderr.join('')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}\nserve stderr:\n${serveStderr.join('')}`);
}

beforeAll(async () => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  // Ambient-state strip: a dev/CI DATABASE_URL must not flip the sandboxed
  // brain to Postgres; GBRAIN_HOOKS/SWEEP must not leak in either direction.
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_BRAIN_ID;
  delete process.env.GBRAIN_HOOKS;
  delete process.env.GBRAIN_BOOTSTRAP_ABORT_AFTER;

  tmpParent = mkdtempSync(join(tmpdir(), 'gb-hus-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  dbDir = join(tmpParent, 'db');
  process.env.GBRAIN_HOME = tmpParent;
  // The serve binds its IPC turn_context handler to GBRAIN_SOURCE; the hook
  // sends the same claim — both sides must agree [CX2-10].
  process.env.GBRAIN_SOURCE = 'workspace';

  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbDir, embedding_dimensions: 1536 }, null, 2),
  );

  ws = mkdtempSync(join(tmpdir(), 'gb-hus-ws-'));
  mkdirSync(join(ws, 'brain'), { recursive: true });

  // Pre-init the brain in-process (schema + source) so the serve subprocess
  // boots fast and doesn't spend its boot budget on migrations. Also SEED the
  // synthetic corpus (pages + world/private beliefs) into the serve's source
  // BEFORE the serve takes the single-writer lock — the serve then reads this
  // committed data when it assembles turn context, so Pin 1 can assert on real
  // recalled content (world belief present, private belief fenced out) instead
  // of accepting an empty block [GAP 2].
  const engineConfig = { engine: 'pglite' as const, database_path: dbDir };
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  await engine.initSchema();
  await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true });
  await loadCorpusPages(engine, { sourceId: 'workspace' });
  const seededBeliefs = await loadCorpusBeliefs(engine, { sourceId: 'workspace' });
  if (seededBeliefs < 1) throw new Error('corpus beliefs failed to seed — GAP 2 has nothing to recall');
  await engine.disconnect();

  // REAL serve subprocess. stdin stays open (a stdin EOF is serve's shutdown
  // signal); env is passed EXPLICITLY (Bun.spawn without env uses the startup
  // snapshot and would miss the sandboxed GBRAIN_HOME).
  serveProc = Bun.spawn(['bun', 'run', join(REPO_ROOT, 'src', 'cli.ts'), 'serve'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GBRAIN_HOME: tmpParent,
      HOME: tmpParent,
      GBRAIN_SOURCE: 'workspace',
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
      GBRAIN_SWEEP: '0',
      GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '300',
    } as Record<string, string>,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Drain stderr in the background for diagnostics (never blocks the test).
  void (async () => {
    const reader = (serveProc!.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        serveStderr.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* child gone */
    }
  })();

  // Readiness: the IPC socket + shared secret appear once serve owns the
  // engine (and therefore the PGLite single-writer lock).
  const sock = resolveSocketPath(dbDir);
  const secret = ipcSecretPath(dbDir);
  await pollFor(() => existsSync(sock) && existsSync(secret), 120_000, 'IPC socket + secret');
}, 240_000);

afterAll(async () => {
  if (serveProc && serveProc.exitCode === null) {
    try {
      serveProc.kill('SIGKILL');
      await serveProc.exited;
    } catch {
      /* already dead */
    }
  }
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  for (const dir of [tmpParent, ws]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('bootstrap hook under a live serve (serial e2e) [A7]', () => {
  test('serve is live: IPC socket + secret exist and the child is running', () => {
    expect(serveProc).not.toBeNull();
    expect(serveProc!.exitCode).toBeNull();
    expect(existsSync(resolveSocketPath(dbDir))).toBe(true);
    expect(existsSync(ipcSecretPath(dbDir))).toBe(true);
  }, 30_000);

  test('Pin 1: user-prompt hook with a LIVE serve → exit 0 + additionalContext carrying the recalled WORLD belief, never the PRIVATE one', async () => {
    // Transcript fixture under the confinement seam root.
    const projRoot = join(tmpParent, 'projects');
    mkdirSync(join(projRoot, 'p1'), { recursive: true });
    const transcript = join(projRoot, 'p1', 'session.jsonl');
    copyFileSync(TRANSCRIPT_FIXTURE, transcript);

    // Drive the turn off a real gold recall case: its query is the prompt, its
    // expected substring is a WORLD belief we seeded, and its must_not is the
    // PRIVATE sibling belief the visibility fence must keep out of the block.
    const beliefCase = loadCorpusQueries().find((q) => q.id === 'belief-recall-alice-standups');
    expect(beliefCase).toBeDefined();
    expect(beliefCase!.expect_substring).toBeDefined();
    expect(beliefCase!.must_not_substring).toBeDefined();

    const out = collectStdout();
    const code = await runHook(['user-prompt'], {
      stdin: JSON.stringify({
        prompt: beliefCase!.query,
        session_id: 'hook-under-serve-1',
        transcript_path: transcript,
      }),
      write: out.write,
      cwd: ws,
      transcriptRoot: projRoot,
    });
    expect(code).toBe(0);

    const payload = out.get().trim();
    const [hb] = await readHeartbeatTail(1);
    expect(hb).toBeDefined();
    expect(hb.event).toBe('user-prompt');
    expect(hb.outcome).not.toBe('error');

    // Every distinctive fragment of a PRIVATE belief that must NEVER cross the
    // IPC boundary (the meta-hook pins visibility=['world'] for the hook path).
    const privateFragments = loadCorpusBeliefData()
      .filter((b) => b.visibility === 'private')
      .map((b) => b.text);

    if (payload.length > 0) {
      // Happy path: assert the REAL recalled content, not length>0. The
      // assembled block must carry the seeded WORLD belief the gold case
      // expects, and NONE of the private beliefs.
      const parsed = JSON.parse(payload) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain(beliefCase!.expect_substring!);
      expect(ctx).not.toContain(beliefCase!.must_not_substring!);
      for (const frag of privateFragments) expect(ctx).not.toContain(frag);
    } else {
      // Empty stdout MUST be a documented degradation recorded in the
      // heartbeat — never a silent nothing, never a wiring-broken reason. A
      // degraded turn also, trivially, leaked no private content.
      expect(hb.reason).toBeDefined();
      expect(DOCUMENTED_LIVE_SERVE_REASONS.has(hb.reason!)).toBe(true);
    }
  }, 60_000);

  test('Pin 2: the hook never acquires the PGLite lock; a direct engine open DOES fail with LiveServeLockError', async () => {
    // 2a — runHook completes under the live serve without any lock error
    // (the hook is engine-free by construction; a LiveServeLockError here
    // would mean someone wired an engine into the hook path).
    const out = collectStdout();
    let hookErr: unknown = null;
    let code = -1;
    try {
      code = await runHook(['user-prompt'], {
        stdin: JSON.stringify({ prompt: 'lock-contention pin', session_id: 'hook-under-serve-2' }),
        write: out.write,
        cwd: ws,
      });
    } catch (e) {
      hookErr = e;
    }
    expect(hookErr).toBeNull();
    expect(code).toBe(0);

    // 2b — the lock IS really held: the narrowest engine-open helper
    // (createEngine + connect, the exact seam every CLI engine command uses)
    // must throw the typed LiveServeLockError, not hang or succeed.
    const engineConfig = { engine: 'pglite' as const, database_path: dbDir };
    const engine = await createEngine(engineConfig);
    let lockErr: unknown = null;
    try {
      await engine.connect(engineConfig);
      // If we get here the lock was NOT held — disconnect and fail loudly.
      await engine.disconnect();
    } catch (e) {
      lockErr = e;
    }
    expect(lockErr).toBeInstanceOf(LiveServeLockError);
    expect((lockErr as Error).message).toContain('gbrain serve');
  }, 90_000);

  test('Pin 3: stale serve (killed, socket left behind) → fail-open exit 0 with ipc_unavailable/no_serve degradation', async () => {
    // SIGKILL: the shutdown handler never runs, so the socket file survives
    // as a stale artifact — exactly the crashed-serve shape.
    expect(serveProc).not.toBeNull();
    serveProc!.kill('SIGKILL');
    await serveProc!.exited;
    const sock = resolveSocketPath(dbDir);
    expect(existsSync(sock)).toBe(true); // stale socket really left behind

    const out = collectStdout();
    const code = await runHook(['user-prompt'], {
      stdin: JSON.stringify({ prompt: 'is anyone home?', session_id: 'hook-under-serve-3' }),
      write: out.write,
      cwd: ws,
    });
    expect(code).toBe(0);
    expect(out.get()).toBe(''); // fail-open: empty stdout, never an error blob

    const [hb] = await readHeartbeatTail(1);
    expect(hb).toBeDefined();
    expect(hb.event).toBe('user-prompt');
    expect(hb.outcome).toBe('degraded');
    // ECONNREFUSED on the dead socket → ipc_unavailable; a cleaned-up secret
    // would surface as no_serve. Both are the documented stale-serve class.
    expect(hb.reason).toBeDefined();
    expect(['ipc_unavailable', 'no_serve']).toContain(hb.reason as string);
  }, 60_000);
});

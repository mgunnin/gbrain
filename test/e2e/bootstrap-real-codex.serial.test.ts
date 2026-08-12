/**
 * REAL-agent door test — Codex edition. Drives the ACTUAL `codex` binary (no
 * PATH shim) against a real gbrain, over the two seams that matter for Codex:
 *
 *   1. INSTALL — the real `gbrain bootstrap` CLI (keyless `gbrain init`,
 *      interview --set/--confirm, render, then `gbrain bootstrap hooks
 *      --harness codex` executing the REAL `codex mcp add` into a hermetic
 *      ~/.codex/config.toml). Asserts the registration landed (real `codex mcp
 *      get gbrain` + the temp config.toml carry our server + GBRAIN_SOURCE),
 *      `gbrain bootstrap verify` exits 0, and the rendered AGENTS.md carries the
 *      Gate-3 brain-first pull protocol — Codex's ONLY per-turn mechanism (it
 *      has no hook system).
 *
 *   2. SMOKE — a live `codex exec` turn. gbrain is registered as a Codex stdio
 *      MCP server (`bun run <repo>/src/cli.ts serve --surface full`) pinned to a
 *      seeded keyless brain. Codex is asked a single question whose answer only
 *      the brain holds; we assert a gbrain tool/command shows up in the turn AND
 *      the seeded fact surfaces in the final text. Proves: real codex → gbrain
 *      MCP → brain → fact. Falls back to the AGENTS.md pull protocol + a direct
 *      shell instruction (`gbrain query`) if headless stdio-MCP is unreliable;
 *      the assertion documents which path proved out.
 *
 * EVERYTHING is hermetic (temp HOME / CODEX_HOME / GBRAIN_HOME per test) and the
 * whole file self-SKIPS via describe.skipIf when the codex binary or its auth is
 * absent, so it is a clean no-op on a runner without them. Serial: PGLite cold
 * starts + a real codex spawn would starve parallel siblings; every test carries
 * an explicit timeout. Real turns cost API + take 30s–2min — prompts are minimal
 * (one seeded fact, one question) and capped at 240s.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveCodexBinary,
  hasCodexAuth,
  codexExecTurn,
  seedBrainForAgent,
  hermeticChildEnv,
  resolveGbrainServerCommand,
} from '../helpers/agent-harness.ts';
import { runBootstrap } from '../../src/commands/bootstrap.ts';
import type { ExecRunner } from '../../src/core/bootstrap/repo.ts';
import { initState, setAnswer, confirm, readBackHash } from '../../src/core/bootstrap/interview.ts';
import { readManifest } from '../../src/core/bootstrap/format.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { addSource } from '../../src/core/sources-ops.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const CODEX_BIN = resolveCodexBinary();
const CAN_RUN = !!CODEX_BIN && hasCodexAuth();

const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Lifeboat',
  PRINCIPAL_NAME: 'Pat Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; builds internal tooling; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_BOOTSTRAP_ABORT_AFTER',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'CODEX_SANDBOX', 'CODEX_CI',
];
const SAVED_ENV: Record<string, string | undefined> = {};

/** Seed a hermetic ~/.codex under `home` with ONLY the operator's real
 *  auth.json (read-only copy) so a spawned codex authenticates without ever
 *  touching the real config dir. Deliberately does NOT copy the operator's
 *  real config.toml: it defines the operator's private remote MCP servers
 *  (which require secrets we don't have and would fail the whole session), and
 *  copying private server names is a privacy smell. `codex mcp add` writes a
 *  fresh, gbrain-only config.toml on top of this. */
function seedCodexHome(home: string): string {
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  const src = join(homedir(), '.codex', 'auth.json');
  const dst = join(codexHome, 'auth.json');
  if (existsSync(src) && !existsSync(dst)) {
    try { cpSync(src, dst); } catch { /* best-effort */ }
  }
  // Placeholder global identity files so codexExecTurn's copy-if-missing loop
  // never pulls the operator's PRIVATE ~/.codex/{AGENTS,SOUL}.md into the turn
  // (behavior + privacy). The per-turn instruction rides the prompt instead.
  for (const f of ['AGENTS.md', 'SOUL.md']) {
    const p = join(codexHome, f);
    if (!existsSync(p)) {
      try { writeFileSync(p, '<!-- hermetic test placeholder -->\n'); } catch { /* best-effort */ }
    }
  }
  return codexHome;
}

/** Run the REAL `codex` binary under a hermetic HOME/CODEX_HOME. Used both as
 *  the bootstrap `hooks` exec runner (so `codex mcp add` writes the temp
 *  config.toml) and for direct `codex mcp get`/`list` probes. */
function makeCodexRunner(home: string): ExecRunner {
  const codexHome = join(home, '.codex');
  return async (argv: string[]) => {
    try {
      const proc = Bun.spawn(argv, {
        env: hermeticChildEnv(
          { HOME: home, CODEX_HOME: codexHome },
          { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] },
        ),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } catch (e) {
      return { code: 127, stdout: '', stderr: (e as Error).message };
    }
  };
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const orig = console.log;
  let out = '';
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(' ') + '\n';
  };
  try {
    const result = await fn();
    return { result, out };
  } finally {
    console.log = orig;
  }
}

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  // Ambient-state strip: a dev/CI DATABASE_URL must not flip the sandboxed
  // brain to Postgres; stray GBRAIN_SOURCE/CODEX_* must not leak into a child.
  for (const k of ENV_KEYS) delete process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

describe.skipIf(!CAN_RUN)('bootstrap real-codex door (serial e2e)', () => {
  // ── 1. INSTALL ────────────────────────────────────────────────────────────
  test('INSTALL: keyless init → interview → render → real `codex mcp add` → verify', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gb-rc-home-'));
    const ws = mkdtempSync(join(tmpdir(), 'gb-rc-ws-'));
    const codexHost = mkdtempSync(join(tmpdir(), 'gb-rc-codex-'));
    const shimDir = mkdtempSync(join(tmpdir(), 'gb-rc-bin-'));
    const savedHome = process.env.GBRAIN_HOME;
    try {
      // A fresh git workspace (the cwd the human pasted into) with a brain/ dir.
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws });
      mkdirSync(join(ws, 'brain'), { recursive: true });

      // Hermetic ~/.codex for the real `codex mcp add`.
      seedCodexHome(codexHost);
      const codexRunner = makeCodexRunner(codexHost);

      // A dummy absolute gbrain binary the registration records (never executed
      // by INSTALL — the mcp-add just writes its path into config.toml).
      const gbrainBin = join(shimDir, 'gbrain');
      Bun.write(gbrainBin, '#!/bin/sh\nexit 0\n');
      execFileSync('chmod', ['+x', gbrainBin]);

      process.env.GBRAIN_HOME = gbHome;

      // (a) Keyless init — the REAL CLI, non-interactive, no embedding provider.
      const init = spawnSync('bun', ['run', CLI, 'init', '--pglite', '--no-embedding', '--non-interactive'], {
        cwd: ws,
        env: { ...process.env, GBRAIN_HOME: gbHome },
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(init.status).toBe(0);
      const dbPath = join(gbHome, '.gbrain', 'brain.pglite');
      expect(existsSync(dbPath)).toBe(true);

      // Register the workspace source the interview's default GBRAIN_SOURCE
      // routes to (verify's write-through needs a source with a localPath).
      const engineConfig = { engine: 'pglite' as const, database_path: dbPath };
      const engine = await createEngine(engineConfig);
      await engine.connect(engineConfig);
      await engine.initSchema();
      await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true });
      await engine.disconnect();

      // (b) Interview — scripted answers, read-back hash confirm.
      expect(initState(ws).ok).toBe(true);
      for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
        const r = setAnswer(ws, key, value);
        if (!r.ok) throw new Error(r.message);
      }
      const h = readBackHash(ws);
      if (!h.ok) throw new Error(h.message);
      expect(confirm(ws, h.hash).ok).toBe(true);

      // (c) Render — identity files + manifest.
      expect(await runBootstrap(['render', '--workspace', ws])).toBe(0);
      expect(readManifest(ws).state).toBe('initialized');

      // AGENTS.md carries the Gate-3 brain-first pull protocol (Codex's only
      // per-turn mechanism — it has no hook system).
      const agents = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('Gate 3');
      expect(agents.toLowerCase()).toContain('brain first');
      expect(agents).toContain('recall');

      // (d) hooks --harness codex → REAL `codex mcp add` via the runner seam.
      const { result: hooksCode, out: hooksOut } = await captureStdout(() =>
        runBootstrap(['hooks', '--workspace', ws, '--harness', 'codex', '--gbrain-bin', gbrainBin], {
          runner: codexRunner,
        }),
      );
      expect(hooksCode).toBe(0);
      // Codex has no hooks — the pull protocol is the per-turn seam, stated plainly.
      expect(hooksOut).toContain('Codex has no hook system');

      // Real `codex mcp get gbrain` shows our server (env values are masked in
      // the human view, so the source binding is asserted on config.toml below).
      const get = await codexRunner(['codex', 'mcp', 'get', 'gbrain']);
      expect(get.code).toBe(0);
      expect(get.stdout).toContain('gbrain');
      expect(get.stdout).toContain('serve');
      expect(get.stdout).toContain('GBRAIN_SOURCE');

      // The hermetic config.toml the real codex wrote carries our server +
      // the exact GBRAIN_SOURCE binding (the [G1] workspace-source routing).
      const toml = readFileSync(join(codexHost, '.codex', 'config.toml'), 'utf8');
      expect(toml).toContain('[mcp_servers.gbrain]');
      expect(toml).toContain(gbrainBin);
      expect(toml).toContain('GBRAIN_SOURCE = "workspace"');

      // (e) verify → exit 0 (keyless PGLite; no repo/hooks for the codex path).
      const { result: verifyCode, out: verifyOut } = await captureStdout(() =>
        runBootstrap(['verify', '--workspace', ws, '--json']),
      );
      expect(verifyCode).toBe(0);
      const payload = JSON.parse(verifyOut) as { ok: boolean; checks: Array<{ id: string; ok: boolean }> };
      expect(payload.ok).toBe(true);
      const roundtrip = payload.checks.find((c) => c.id === 'roundtrip');
      expect(roundtrip?.ok).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      for (const d of [gbHome, ws, codexHost, shimDir]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 300_000);

  // ── 2. SMOKE ────────────────────────────────────────────────────────────────
  test('SMOKE: real `codex exec` → gbrain MCP → brain → seeded fact', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-rc-smoke-'));
    try {
      // `codex exec` refuses an untrusted cwd ("Not inside a trusted
      // directory"); a git repo satisfies the check. The turn runs with
      // cwd=home, so make home a repo (never committed to).
      execFileSync('git', ['init', '-q', home]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: home });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: home });

      // Seed a keyless brain the spawned `gbrain serve` will read.
      const sourceId = 'workspace';
      const seeded = await seedBrainForAgent(home, sourceId);

      // Hermetic ~/.codex (auth + model settings), then register gbrain as a
      // stdio MCP server pinned to the seeded brain via the REAL `codex mcp add`
      // (exact shape from docs/mcp/CODEX.md + registerCodexMcp). Prefer a
      // compiled binary so MCP startup is fast enough that codex's tool-call
      // window doesn't close before the server is ready (the "the available
      // gbrain mcp calls were cancelled" flake); fall back to `bun run
      // src/cli.ts serve` otherwise.
      seedCodexHome(home);
      const runner = makeCodexRunner(home);
      const server = resolveGbrainServerCommand(REPO_ROOT, ['--surface', 'full']);
      const add = await runner([
        'codex', 'mcp', 'add', 'gbrain',
        '--env', `GBRAIN_HOME=${home}`,
        '--env', `GBRAIN_SOURCE=${sourceId}`,
        '--', server.command, ...server.args,
      ]);
      expect(add.code).toBe(0);

      // The prompt names the shell fallback explicitly: if the MCP tool is
      // unavailable, run `gbrain query` — which resolves to $HOME/.gbrain
      // (== the seeded brain, since HOME is the temp dir).
      const prompt =
        `You have a gbrain MCP tool connected to a knowledge brain. ` +
        `Using ONLY that brain (do not guess, do not use general knowledge), answer: ` +
        `${seeded.query} Report exactly what the brain says. ` +
        `If no gbrain MCP tool is available, run the shell command ` +
        `\`bun run ${CLI} query "${seeded.query}"\` and answer from its output.`;

      // Bounded retry (max 2) rides out a transient MCP-startup cancellation.
      // PASS only when an attempt lands BOTH a gbrain tool/command AND the
      // seeded fact; never pass on zero tool calls, never soften.
      const fact = 'rivermouth';
      const perAttemptTimeout = server.kind === 'compiled' ? 190_000 : 230_000;
      const maxAttempts = 2;
      let passed = false;
      let lastEvidence = '';

      for (let attempt = 1; attempt <= maxAttempts && !passed; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 3_000));
        const turn = await codexExecTurn({ prompt, cwd: home, home, timeoutMs: perAttemptTimeout });
        const raw = turn.rawLines.join('\n');
        // The harness JSONL parser only captures command_execution/agent_message/
        // reasoning — a Codex MCP tool call is a distinct `mcp_tool_call` item, so
        // detect it on the raw stream. server:"gbrain" proves the call hit OUR
        // registered brain server (not general knowledge).
        const usedMcp = /"type"\s*:\s*"mcp_tool_call"[^\n]*"server"\s*:\s*"gbrain"/.test(raw);
        // Shell fallback: codex ran our `gbrain query` command (surfaced in the
        // parsed command_execution toolCalls). Either path is a valid proof of
        // real codex → real gbrain → brain.
        const usedShell = turn.toolCalls.some((c) => /gbrain|cli\.ts\s+query|\bquery\b/i.test(c));
        const usedGbrain = usedMcp || usedShell;
        const gotFact = turn.finalText.toLowerCase().includes(fact);

        lastEvidence =
          `[smoke codex attempt ${attempt}/${maxAttempts}] server=${server.kind} ` +
          `exit=${turn.exitCode} timedOut=${turn.timedOut} usedMcp=${usedMcp} usedShell=${usedShell} gotFact=${gotFact}\n` +
          `toolCalls=${JSON.stringify(turn.toolCalls)}\n` +
          `finalText=${turn.finalText.slice(0, 800)}`;
        console.log(lastEvidence);

        if (usedGbrain && gotFact) passed = true;
      }

      expect(passed, `SMOKE failed on all ${maxAttempts} attempts.\n${lastEvidence}`).toBe(true);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 480_000);
});

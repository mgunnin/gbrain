/**
 * `gbrain bootstrap` — the dispatcher tying the bootstrap lane modules into
 * one CLI family (agent-bootstrap plan: D3, G9, B1, CX2-5, A7).
 *
 * Engine discipline (plan D5 + ENG-2): every subcommand except `verify` is
 * ENGINE-FREE — a live `gbrain serve` may hold the PGLite single-writer lock
 * while the human is mid-install, and interview/render/hooks/repo/status/
 * uninstall/attach must keep working. `verify` NEEDS the engine and manages
 * its own connection (the commands/cache.ts pattern: loadConfig →
 * createEngine → connect → finally disconnect) — it runs precisely when no
 * serve is live (pre-registration, or the operator closed sessions for the
 * weekly re-run) [CX2-5].
 *
 * [G9] Mutating subcommands (render/repo/hooks/uninstall/attach) run under
 * the workspace bootstrap mutex; a collision is the typed
 * BOOTSTRAP_IN_PROGRESS refusal the runbook relays.
 *
 * [B1] Every subcommand (except the read-only `status`) appends one line to
 * `<home>/bootstrap/install.jsonl`.
 *
 * [A7] `GBRAIN_BOOTSTRAP_ABORT_AFTER=<phase>` is the deterministic
 * kill-mid-phase seam: after the named phase's main mutation completes (and
 * BEFORE the install-log/receipt finalization) the dispatcher throws — the
 * lifecycle e2e then asserts `bootstrap status` resumes from the artifacts.
 *
 * Every error path prints agent-readable text plus the support hint (the
 * B5 relay instruction), never a stack trace.
 */

import { mkdirSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { VERSION } from '../version.ts';
import { loadConfig, loadConfigFileOnly, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { resolveGbrainHome } from '../core/gbrain-home.ts';
import { realpathOrResolve } from '../core/path-confine.ts';
import { loadQuestionBank } from '../core/bootstrap/assets.ts';
import {
  initState,
  setAnswer,
  skipAnswer,
  status as interviewStatus,
  show as interviewShow,
  confirm as interviewConfirm,
  readBackHash,
  readInterviewState,
  routeProviderKeyToConfig,
} from '../core/bootstrap/interview.ts';
import { renderWorkspace, BootstrapRenderError } from '../core/bootstrap/render.ts';
import { acquireBootstrapLock, BootstrapError } from '../core/bootstrap/lock.ts';
import { createPrivateRepo, defaultRunner, type ExecRunner, type RepoReceipt } from '../core/bootstrap/repo.ts';
import { attachWorkspace } from '../core/bootstrap/attach.ts';
import { uninstallWorkspace } from '../core/bootstrap/uninstall.ts';
import {
  registerClaudeMcp,
  registerCodexMcp,
  writeClaudeHooks,
  removeClaudeHooks,
} from '../core/bootstrap/hooks.ts';
import {
  guardReceiptOverwrite,
  readManifest,
  readReceipt,
  writeReceipt,
  type InstallReceipt,
} from '../core/bootstrap/format.ts';
import {
  appendInstallLog,
  gitOriginUrl,
  probeOriginVisibility,
  statusReport,
  type StatusReport,
} from '../core/bootstrap/status.ts';
import { verifyWorkspace } from '../core/bootstrap/verify.ts';

export const BOOTSTRAP_HELP = `gbrain bootstrap — paste-in agent install (Claude Code / Codex)

Usage: gbrain bootstrap <subcommand> [flags]

Subcommands (run \`gbrain bootstrap status\` first — it is the resume entrypoint):
  status [--json]                 Phase list + next action + support blob. The CLI's
                                  phase list is the source of truth the runbook defers to.
  interview --init                Create state/interview.json.
            --set KEY "value"     Record one answer verbatim (never invent answers).
            --skip KEY            Decline an optional question.
            --status              Gate: exits nonzero until required answers exist.
            --show                Read-back payload (all answers + confirm hash).
            --confirm <hash>      Record the human's confirmation of the read-back.
  render [--force] [--only F] [--minimal]
                                  Render identity files from the confirmed answers.
                                  Never clobbers; --force backs up first.
  hooks [--harness claude-code|codex] [--repair] [--no-hooks] [--gbrain-bin <path>]
                                  Register MCP (+ per-turn hooks on Claude Code,
                                  ON by default; --no-hooks opts out, GBRAIN_HOOKS=0
                                  disables at runtime).
  repo                            Create the dedicated PRIVATE GitHub repo (or adopt
                                  an EMPTY private repo you created under your own
                                  account), verify the privacy bit via the API, push.
  verify [--json]                 The whole install contract (round-trip, graph floor,
                                  magic moment, scans, hooks smoke). Exit 0 or not done.
  attach [--harness H]            Machine two: adopt a cloned agent workspace.
  uninstall [--delete-brain] [--home <dir>] [--yes]
                                  Receipt-keyed removal. The repo stays yours.

Global flags: --workspace <dir> (default: cwd), --help.
Env: GBRAIN_BOOTSTRAP_ABORT_AFTER=<phase> (test seam — abort after that phase's work).
`;

const SUPPORT_HINT =
  'If you are stuck: run `gbrain bootstrap status --json` and relay the "support" block verbatim.';

/** Thrown by the A7 abort seam; mapped to exit 130 (simulated kill). */
export class BootstrapAbortInjected extends Error {
  constructor(phase: string) {
    super(`bootstrap aborted after phase '${phase}' (GBRAIN_BOOTSTRAP_ABORT_AFTER) — re-run and \`gbrain bootstrap status\` resumes from the artifacts`);
    this.name = 'BootstrapAbortInjected';
  }
}

function abortIfInjected(phase: string): void {
  if (process.env.GBRAIN_BOOTSTRAP_ABORT_AFTER === phase) {
    throw new BootstrapAbortInjected(phase);
  }
}

// ── Flag helpers ────────────────────────────────────────────────────────────

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : undefined;
}

function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) {
      out.push(...args[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
}

function resolveWorkspace(args: string[]): string {
  const ws = flagValue(args, '--workspace');
  return ws ? resolve(ws) : process.cwd();
}

// ── Shared plumbing ─────────────────────────────────────────────────────────

type Harness = 'claude-code' | 'codex';

/** Best-effort harness auto-detect; the --harness flag always wins. */
export function detectHarness(env: Record<string, string | undefined> = process.env): Harness | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_CI) return 'codex';
  return null;
}

/** Absolute gbrain binary path for registrations/hook commands [CX-P1.4].
 * GUI hosts inherit no PATH, so a bare name is never acceptable. */
function resolveGbrainBin(): string | null {
  try {
    const which = Bun.which('gbrain');
    if (which && isAbsolute(which)) return which;
  } catch {
    /* fall through */
  }
  // Compiled-binary case: this process IS the gbrain binary.
  if (basename(process.execPath).startsWith('gbrain')) return process.execPath;
  return null;
}

/**
 * [FIX7] Does the host's existing `gbrain` MCP registration target THIS
 * workspace's serve? An "already exists/registered" error is NOT proof the
 * registration is ours — it could point at a different workspace's binary or
 * a stale/foreign install. Verify via `<host> mcp get <name>` that the command
 * carries both the expected absolute gbrain binary AND GBRAIN_SOURCE=<sourceId>.
 *
 * Returns 'match' (ours), 'mismatch' (points elsewhere — caller re-registers or
 * warns), or 'unknown' (the host has no `mcp get` / empty output — inconclusive,
 * never silently blessed).
 */
async function verifyMcpTargetsWorkspace(
  runner: ExecRunner,
  harness: Harness,
  name: string,
  gbrainBin: string,
  sourceId: string,
): Promise<'match' | 'mismatch' | 'unknown'> {
  const bin = harness === 'claude-code' ? 'claude' : 'codex';
  let res;
  try {
    res = await runner([bin, 'mcp', 'get', name]);
  } catch {
    return 'unknown';
  }
  if (res.code !== 0) return 'unknown';
  const out = `${res.stdout}\n${res.stderr}`;
  if (out.trim() === '') return 'unknown';
  const hasBin = out.includes(gbrainBin);
  const hasSource = out.includes(`GBRAIN_SOURCE=${sourceId}`);
  return hasBin && hasSource ? 'match' : 'mismatch';
}

async function withLock<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireBootstrapLock(ws);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

interface LogCtx {
  home: string;
  ws: string;
  harness?: string;
}

function logPhase(ctx: LogCtx, phase: string, outcome: 'ok' | 'error' | 'aborted', t0: number): void {
  appendInstallLog(ctx.home, {
    ts: new Date().toISOString(),
    phase,
    outcome,
    duration_ms: Date.now() - t0,
    binary_version: VERSION,
    ...(ctx.harness ? { harness: ctx.harness } : {}),
    workspace: ctx.ws,
  });
}

/** Consent answer resolution: persisted interview answer > bank default.
 * An explicitly SKIPPED answer is a DECLINE ('no'), never the bank default —
 * skipping HOOKS_CONSENT (bank default 'yes') must not install hooks. */
function consentAnswer(ws: string, key: string): string | undefined {
  const bank = loadQuestionBank();
  const read = readInterviewState(ws);
  if (read.ok) {
    const a = read.state.answers[key];
    if (a?.skipped === true) return 'no';
    // Shape-tolerant: interview.json is user-editable and readInterviewState
    // validates only that `answers` is an object — a hand-edited unusable
    // value (non-string, empty, or a bare {}) must never throw at a
    // `.toLowerCase()` call site. FAIL CLOSED, loudly: falling through to a
    // permissive bank default could flip a damaged opt-out into consent
    // (cross-model adversarial finding); 'no' resolves every consent key to
    // its safe reading (no hooks, no cron, project scope).
    if (a && typeof a.value === 'string' && a.value) return a.value;
    if (a) {
      console.error(
        `note: the recorded ${key} answer in state/interview.json is unusable (invalid shape) — ` +
          'treating it as declined (fail-closed). Re-record it with `gbrain bootstrap interview` ' +
          'if that is not what you want.',
      );
      return 'no';
    }
  }
  return bank.questions[key]?.default;
}

/** Post-render machine receipt [CX2-1/CX2-12]; preserves an existing same-
 * workspace receipt's ownership fields (mirrors attach.ts). */
function writeRenderReceipt(home: string, ws: string): void {
  const state = readManifest(ws);
  if (state.state !== 'initialized') return;
  // Pre-write guard [CX2-12]: a newer-format receipt refuses (upgrade first);
  // an unreadable one is backed up loudly, never silently clobbered.
  const guard = guardReceiptOverwrite(home);
  if (guard.brokenBackupPath) {
    console.error(`WARNING: the install receipt was unreadable; backed it up to ${guard.brokenBackupPath} and wrote a fresh one.`);
  }
  const manifest = state.manifest;
  const resolvedWs = realpathOrResolve(ws);
  const existing = readReceipt(home);
  const same = existing !== null && realpathOrResolve(existing.workspace_dir) === resolvedWs;
  const receipt: InstallReceipt = {
    receipt_version: 1,
    workspace_dir: resolvedWs,
    source_id: manifest.source_id,
    agent_name: manifest.agent_name,
    created_at: same ? existing.created_at : new Date().toISOString(),
    created_by: `gbrain@${VERSION}`,
    brain_created_by_bootstrap: same ? existing.brain_created_by_bootstrap : false,
    created_paths: same ? existing.created_paths : [],
    registrations: same ? existing.registrations : [],
  };
  // Preserve structural extensions (repo_url) from a prior run.
  const prior = existing as (InstallReceipt & { repo_url?: string }) | null;
  if (same && prior?.repo_url) (receipt as InstallReceipt & { repo_url?: string }).repo_url = prior.repo_url;
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeReceipt(home, receipt);
}

function appendReceiptRegistration(
  home: string,
  ws: string,
  reg: { host: Harness; scope: string; detail?: string },
): void {
  // Pre-write guard [CX2-12]: newer-format → refuse; unreadable → loud backup.
  const guard = guardReceiptOverwrite(home);
  if (guard.brokenBackupPath) {
    console.error(`WARNING: the install receipt was unreadable; backed it up to ${guard.brokenBackupPath} and wrote a fresh one.`);
  }
  const existing = readReceipt(home);
  const resolvedWs = realpathOrResolve(ws);
  // Fresh-receipt identity comes from the workspace manifest (source_id may be
  // a collision-derived id like 'workspace-<hash>'), never a hardcoded default.
  const manifest = readManifest(ws);
  const base: InstallReceipt =
    existing !== null && realpathOrResolve(existing.workspace_dir) === resolvedWs
      ? existing
      : {
          receipt_version: 1,
          workspace_dir: resolvedWs,
          source_id: manifest.state === 'initialized' ? manifest.manifest.source_id : 'workspace',
          agent_name: manifest.state === 'initialized' ? manifest.manifest.agent_name : 'agent',
          created_at: new Date().toISOString(),
          created_by: `gbrain@${VERSION}`,
          brain_created_by_bootstrap: false,
          created_paths: [],
          registrations: [],
        };
  const dedup = base.registrations.filter((r) => !(r.host === reg.host && r.scope === reg.scope));
  base.registrations = [...dedup, reg];
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeReceipt(home, base);
}

// ── Subcommands ─────────────────────────────────────────────────────────────

async function runStatus(ws: string, rest: string[], home: string): Promise<number> {
  const report: StatusReport = await statusReport(ws, { gbrainHomeDir: home });
  // Template-door privacy gate: PUBLIC origin on a template clone is a hard
  // stop (exit non-zero) — identity files must never land in a public repo.
  const gate = report.privacy_gate;
  if (rest.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    if (gate?.verdict === 'public') {
      console.error(
        `STOP: this template clone's origin (${gate.origin}) is PUBLIC. Make the repository private first ` +
          `(gh repo edit --visibility private --accept-visibility-change-consequences, or the GitHub settings page), then re-run \`gbrain bootstrap status\`.`,
      );
      return 1;
    }
    return 0;
  }
  console.log(`gbrain bootstrap status — ${ws}`);
  for (const p of report.phases) {
    const mark = p.state === 'done' ? 'done   ' : p.state === 'partial' ? 'partial' : p.state === 'skipped' ? 'skipped' : 'pending';
    console.log(`  [${mark}] ${p.id.padEnd(9)} ${p.title}${p.detail ? ` — ${p.detail}` : ''}`);
  }
  if (report.next) {
    console.log(`\nNext: ${report.next}`);
  } else {
    console.log('\nAll phases done. Weekly self-check: `gbrain bootstrap verify`.');
  }
  if (report.runbookSkew) {
    console.log(
      `\nWARNING: runbook stamp ${report.runbookSkew.runbookStamp} != installed binary ${report.runbookSkew.binaryVersion} — ` +
        'prefer the binary; re-fetch the runbook from the latest-stable ref.',
    );
  }
  console.log('\nSupport (relay verbatim when something is broken):');
  console.log(JSON.stringify(report.support, null, 2));
  if (gate?.verdict === 'public') {
    console.error(
      `\nSTOP: this template clone's origin (${gate.origin}) is PUBLIC. Identity files must never land in a ` +
        `public repository. Make it private first (gh repo edit --visibility private ` +
        `--accept-visibility-change-consequences, or the GitHub settings page), then re-run \`gbrain bootstrap status\`.`,
    );
    return 1;
  }
  if (gate?.verdict === 'unknown') {
    console.error(
      `\nWARNING: could not verify the origin's visibility (${gate.detail}). Treat the repository as public ` +
        'until `gh` can verify it — nothing has been pushed; fix gh (install / `gh auth login` / network) and re-run.',
    );
  }
  return 0;
}

async function runInterview(ws: string, rest: string[]): Promise<number> {
  if (rest.includes('--init')) {
    const r = initState(ws);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    console.log(r.created ? `created ${r.path}` : `already present: ${r.path}`);
    // Print the question bank so the runbook agent can ask from the CLI's copy.
    const bank = loadQuestionBank();
    console.log(`\nAsk in batches (${bank.interviewKeys.length} interview keys, required first):`);
    for (const key of bank.interviewKeys) {
      const q = bank.questions[key];
      console.log(`  [batch ${q?.batch ?? '-'}]${q?.required ? ' (required)' : ''} ${key}: ${q?.question ?? ''}`);
    }
    return 0;
  }
  const setIdx = rest.indexOf('--set');
  if (setIdx >= 0) {
    const key = rest[setIdx + 1];
    const value = rest[setIdx + 2];
    if (!key || value === undefined) {
      console.error('usage: gbrain bootstrap interview --set KEY "value"');
      return 2;
    }
    const r = setAnswer(ws, key, value);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    if (r.sink === 'config') {
      // [CX2-13] Config-sink key: route the raw value to the 0600 config file;
      // nothing lands in interview.json, hashes, or logs.
      const routed = routeProviderKeyToConfig(value);
      if (!routed.ok) {
        console.error(routed.message);
        return 1;
      }
      console.log(`${key}: routed to the 0600 config file (${routed.configKey}). Not recorded in interview state.`);
      return 0;
    }
    console.log(`${key} recorded.`);
    return 0;
  }
  const skipIdx = rest.indexOf('--skip');
  if (skipIdx >= 0) {
    const key = rest[skipIdx + 1];
    if (!key) {
      console.error('usage: gbrain bootstrap interview --skip KEY');
      return 2;
    }
    const r = skipAnswer(ws, key);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    console.log(`${key} skipped.`);
    return 0;
  }
  if (rest.includes('--status')) {
    const st = interviewStatus(ws);
    if (!st.ok) {
      console.error(st.message);
      return 1;
    }
    console.log(`answered: ${st.answered.join(', ') || '(none)'}`);
    console.log(`skipped:  ${st.skipped.join(', ') || '(none)'}`);
    if (!st.complete) {
      console.log(`missing required: ${st.missingRequired.join(', ')}`);
      return 1; // the gate: nonzero until required answers exist
    }
    const h = readBackHash(ws);
    if (h.ok) {
      console.log(`complete. read-back hash: ${h.hash}`);
      console.log(st.confirmed ? 'confirmed.' : 'NOT confirmed — read every answer back to the human, then `--confirm <hash>`.');
    }
    return 0;
  }
  if (rest.includes('--show')) {
    const r = interviewShow(ws);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    for (const e of [...r.entries, ...r.extras]) {
      const state = e.answered ? `"${e.value}"` : e.skipped ? '(skipped)' : e.default !== undefined ? `(default: "${e.default}")` : '(unanswered)';
      console.log(`${e.required ? '*' : ' '} ${e.key}: ${state}`);
    }
    if (r.hash) console.log(`\nread-back hash: ${r.hash}${r.confirmed ? ' (confirmed)' : ''}`);
    return 0;
  }
  const confirmIdx = rest.indexOf('--confirm');
  if (confirmIdx >= 0) {
    const hash = rest[confirmIdx + 1];
    if (!hash) {
      console.error('usage: gbrain bootstrap interview --confirm <hash from --status/--show>');
      return 2;
    }
    const r = interviewConfirm(ws, hash);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    console.log(`confirmed at ${r.at}.`);
    return 0;
  }
  console.error('usage: gbrain bootstrap interview --init | --set K V | --skip K | --status | --show | --confirm <hash>');
  return 2;
}

async function runRender(ws: string, rest: string[], home: string): Promise<number> {
  const force = rest.includes('--force');
  const minimal = rest.includes('--minimal');
  const only = flagValues(rest, '--only');

  // Public-origin gate [FIX6]: identity files (SOUL.md/USER.md/…) must NEVER
  // land in a public repo. `bootstrap status` enforces this for the template
  // door, but a direct `bootstrap render` could bypass it — so enforce here,
  // BEFORE anything is written. PUBLIC → hard refuse; unknown (no gh /
  // offline / non-GitHub) → warn and proceed (render writes locally; nothing
  // is pushed by render).
  const origin = gitOriginUrl(ws);
  if (origin) {
    const vis = probeOriginVisibility(origin);
    if (vis.verdict === 'public') {
      console.error(
        `render refused: this workspace's origin (${origin}) is PUBLIC. Identity files must never land in a ` +
          `public repository. Make it private first (gh repo edit --visibility private ` +
          `--accept-visibility-change-consequences, or the GitHub settings page), then re-run \`gbrain bootstrap render\`.`,
      );
      console.error(SUPPORT_HINT);
      return 1;
    }
    if (vis.verdict === 'unknown') {
      console.error(
        `WARNING: could not verify the origin's visibility (${vis.detail}). Proceeding with render — ` +
          'treat the repository as public until `gh` can verify it (install gh / `gh auth login` / network); ' +
          'render writes locally and nothing is pushed.',
      );
    }
  }

  // DISPATCHER-LEVEL render gate (the interview module doesn't gate — this
  // dispatcher does): a full non-minimal render requires complete + CONFIRMED
  // answers [A8]. --only re-renders (e.g. repo's GITHUB.md refresh) ride the
  // same gate; --minimal is the deterministic template path and skips it.
  if (!minimal) {
    const st = interviewStatus(ws);
    if (!st.ok) {
      console.error(st.message);
      return 1;
    }
    if (!st.complete || !st.confirmed) {
      console.error(
        'render refused: the interview is ' +
          (!st.complete ? `incomplete (missing: ${st.missingRequired.join(', ')})` : 'complete but NOT confirmed') +
          '. Read the answers back to the human, then `gbrain bootstrap interview --confirm <hash>`.',
      );
      return 1;
    }
  }

  return withLock(ws, async () => {
    const receipt = readReceipt(home) as RepoReceipt | null;
    const derived: Record<string, string> = {};
    if (receipt?.repo_url) derived.GITHUB_REPO_URL = receipt.repo_url;
    try {
      const cfg = loadConfigFileOnly();
      const synth = cfg?.dream?.synthesize as Record<string, unknown> | undefined;
      const days = synth?.corpus_retention_days;
      if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
        derived.CORPUS_RETENTION_DAYS = String(days);
      }
    } catch {
      /* canonical fallback applies */
    }

    // source_id seam [source-id collision]: render is ENGINE-FREE (D5/ENG-2)
    // and the sources registry lives only in the DB, so render cannot detect a
    // 'workspace' id already claimed by another checkout. It therefore passes
    // NO sourceId: render.ts preserves an existing manifest source_id and
    // defaults new manifests to 'workspace'; verify (which holds the engine)
    // detects the collision and persists a derived 'workspace-<hash>' id that
    // every consumer reads back from the manifest.
    const res = renderWorkspace(ws, {
      force,
      ...(only.length > 0 ? { only } : {}),
      minimal,
      derived,
      createdBy: `gbrain@${VERSION}`,
    });

    if (only.length === 0 && !minimal) writeRenderReceipt(home, ws);
    abortIfInjected('render');

    console.log(`rendered: ${res.written.join(', ') || '(nothing new)'}`);
    if (res.skipped.length > 0) console.log(`kept (already present — use --force to overwrite): ${res.skipped.join(', ')}`);
    if (res.backups.length > 0) console.log(`backups: ${res.backups.join(', ')}`);
    return 0;
  });
}

async function runRepo(ws: string, rest: string[], home: string, runner: ExecRunner): Promise<number> {
  void rest;
  return withLock(ws, async () => {
    const result = await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    const line =
      result.disposition === 'created'
        ? `created private repo: ${result.url}`
        : result.disposition === 'adopted'
          ? `adopted your existing empty private repo: ${result.url}`
          : `verified existing private repo: ${result.url}`;
    console.log(line);

    // Derived-token refresh of GITHUB.md with the real URL (best-effort —
    // createPrivateRepo already replaced the placeholder in place).
    try {
      renderWorkspace(ws, { only: ['GITHUB.md'], force: true, derived: { GITHUB_REPO_URL: result.url } });
    } catch (e) {
      console.error(`note: GITHUB.md re-render skipped (${(e as Error).message}) — the placeholder replacement already applied`);
    }

    abortIfInjected('repo');

    // PERSIST_CRON consent [D3 resolved]: opt-in 15-min scan-gated push job
    // via the existing sources-harden machinery. Best-effort: a harden
    // failure never fails the repo phase — the SessionEnd push backstop is
    // always on.
    const persist = (consentAnswer(ws, 'PERSIST_CRON') ?? 'no').toLowerCase();
    if (persist === 'yes') {
      try {
        const { hardenBrainRepo } = await import('../core/brain-repo-durability.ts');
        const state = readManifest(ws);
        const sourceId = state.state === 'initialized' ? state.manifest.source_id : 'workspace';
        const report = await hardenBrainRepo({
          repoPath: ws,
          sourceId,
          installCron: true,
          verify: false,
          logger: (l: string) => process.stderr.write(`[harden] ${l}\n`),
        });
        const attention = report.steps.filter((s) => s.status === 'needs_attention');
        console.log(
          attention.length === 0
            ? 'background persistence enabled (15-min scan-gated push job installed).'
            : `background persistence partially enabled — needs attention: ${attention.map((s) => `${s.step}: ${s.detail}`).join('; ')}`,
        );
      } catch (e) {
        console.error(
          `note: background-persistence install failed (${(e as Error).message}). ` +
            'Session-end pushes still persist your work; re-try later with `gbrain sources harden`.',
        );
      }
    } else {
      console.log('background persistence declined — the session-end push remains the persistence backstop.');
    }
    return 0;
  });
}

async function runHooks(ws: string, rest: string[], home: string, runner: ExecRunner): Promise<number> {
  const harnessFlag = flagValue(rest, '--harness') as Harness | undefined;
  const harness = harnessFlag ?? detectHarness();
  if (!harness || (harness !== 'claude-code' && harness !== 'codex')) {
    console.error('cannot auto-detect the harness — pass --harness claude-code or --harness codex');
    return 2;
  }
  // --repair is an idempotent-run alias: the same registration/write path as a
  // first run (marker-keyed dedupe makes re-runs safe); it only changes the log line.
  const repair = rest.includes('--repair');
  // Per-turn hooks are ON by default (installing gbrain-for-your-agent IS the
  // consent — declining defeats the product), so they are no longer prompted.
  // `--no-hooks` is the explicit install-time opt-out; `GBRAIN_HOOKS=0` and
  // `uninstall` are the runtime/after off-ramps.
  const noHooks = rest.includes('--no-hooks');

  const state = readManifest(ws);
  if (state.state !== 'initialized') {
    console.error(
      state.state === 'template'
        ? 'this is an uninitialized template — run `gbrain bootstrap render` first'
        : `not an agent workspace (agent.json ${state.state}) — run \`gbrain bootstrap render\` first`,
    );
    return 1;
  }
  const sourceId = state.manifest.source_id;

  const gbrainBin = flagValue(rest, '--gbrain-bin') ?? resolveGbrainBin();
  if (!gbrainBin) {
    console.error(
      'cannot resolve an absolute gbrain binary path (GUI hosts inherit no PATH) — ' +
        'install gbrain globally (`bun install -g github:garrytan/gbrain#latest-stable`) or pass --gbrain-bin <abs path>',
    );
    return 2;
  }

  const mcpScope = ((consentAnswer(ws, 'MCP_SCOPE') ?? 'project').toLowerCase() === 'user' ? 'user' : 'project') as 'project' | 'user';
  // A persisted 'project' answer is meaningless on Codex (`codex mcp add` has no
  // scope flag) — reachable via attach from a Claude Code machine or a pre-fix
  // install. Fires on each hooks/repair run while the stale answer persists.
  // Raw read, NOT consentAnswer: the bank default is 'project', so the resolved
  // value would fire this note on every Codex install where no one was asked.
  if (harness === 'codex') {
    const read = readInterviewState(ws);
    const raw = read.ok ? read.state.answers['MCP_SCOPE'] : undefined;
    // typeof guard: readInterviewState validates `answers` is an object but not
    // per-answer shapes — a hand-edited value of 3 must not throw.
    if (raw?.skipped !== true && typeof raw?.value === 'string' && raw.value.toLowerCase() === 'project') {
      console.error(
        "note: the recorded MCP_SCOPE answer 'project' has no effect on Codex — " +
          '`codex mcp add` has no scope flag; the registration is user-global (any repo ' +
          'opened on this machine can reach the brain, read and write, through its MCP tools). ' +
          'To clear this note safely, drop the answer with `gbrain bootstrap interview --skip MCP_SCOPE`, ' +
          'then re-confirm the read-back (`--show`, then `--confirm <hash>` — any answer change ' +
          'invalidates the prior confirmation). Do NOT flip it to user: the answer syncs to paired ' +
          'Claude Code machines and would widen their scope. Registration off-ramps: ' +
          '`codex mcp remove gbrain`, or `gbrain bootstrap uninstall` (full teardown).',
      );
    }
  }
  // HOOKS_CONSENT is a silent default (bank: 'yes') — hooks install unless the
  // human explicitly opts out with --no-hooks (or a persisted 'no' answer).
  const hooksConsent = !noHooks && (consentAnswer(ws, 'HOOKS_CONSENT') ?? 'yes').toLowerCase() === 'yes';
  const gbrainHome = process.env.GBRAIN_HOME?.trim() || undefined;

  return withLock(ws, async () => {
    // 1. MCP registration — argv built by the host-format module, executed
    // through the runner seam, recorded on the receipt.
    const argvs =
      harness === 'claude-code'
        ? registerClaudeMcp({ gbrainBin, scope: mcpScope, sourceId, ...(gbrainHome ? { gbrainHome } : {}) })
        : registerCodexMcp({ gbrainBin, sourceId, ...(gbrainHome ? { gbrainHome } : {}) });
    for (const argv of argvs) {
      const mcpName = argv[3] ?? 'gbrain'; // ['<host>','mcp','add',<name>,…]
      const res = await runner(argv);
      if (res.code === 127) {
        console.error(
          `\`${argv[0]}\` is not on PATH — is ${harness} installed? MCP registration skipped; ` +
            `re-run \`gbrain bootstrap hooks --harness ${harness}\` once it is.`,
        );
        return 2;
      }
      if (res.code !== 0) {
        const already = /already exists|already registered/i.test(res.stderr + res.stdout);
        if (!already) {
          console.error(`MCP registration failed (${argv.join(' ')}): ${res.stderr.trim() || `exit ${res.code}`}`);
          return 1;
        }
        // [FIX7] "already registered" is NOT proof the registration is OURS.
        // Verify it targets this workspace's serve; if it points elsewhere,
        // remove + re-add rather than blessing a foreign/stale registration.
        const verdict = await verifyMcpTargetsWorkspace(runner, harness, mcpName, gbrainBin, sourceId);
        if (verdict === 'match') {
          console.log('MCP server already registered for this workspace — kept.');
        } else if (verdict === 'mismatch') {
          console.error(
            `existing '${mcpName}' MCP registration targets a DIFFERENT workspace/binary — replacing it.`,
          );
          await runner([argv[0], 'mcp', 'remove', mcpName]);
          const re = await runner(argv);
          if (re.code !== 0 && !/already exists|already registered/i.test(re.stderr + re.stdout)) {
            console.error(`MCP re-registration failed (${argv.join(' ')}): ${re.stderr.trim() || `exit ${re.code}`}`);
            return 1;
          }
        } else {
          console.log(
            `MCP server '${mcpName}' already registered — could not confirm it targets this workspace ` +
              `(\`${argv[0]} mcp get ${mcpName}\` to inspect); kept.`,
          );
        }
      }
    }

    // 2. Registration smoke [FIX7]: confirm the EXPECTED server (binary path +
    // GBRAIN_SOURCE), not merely a 'gbrain' substring in `mcp list`. Falls back
    // to the list probe only when the host has no `mcp get`.
    try {
      const listBin = harness === 'claude-code' ? 'claude' : 'codex';
      const scopeLabel = harness === 'claude-code' ? mcpScope : 'user-global';
      const verdict = await verifyMcpTargetsWorkspace(runner, harness, 'gbrain', gbrainBin, sourceId);
      if (verdict === 'match') {
        console.log(`MCP registered with ${harness} (scope: ${scopeLabel}) — verified targeting this workspace.`);
      } else if (verdict === 'mismatch') {
        console.error(
          `WARNING: \`${listBin} mcp get gbrain\` does not show this workspace's serve ` +
            `(binary/source mismatch) — re-run \`gbrain bootstrap hooks --harness ${harness} --repair\`.`,
        );
      } else {
        const probe = await runner([listBin, 'mcp', 'list']);
        if (probe.code === 0 && /\bgbrain\b/.test(probe.stdout)) {
          console.log(
            `MCP registration submitted (server 'gbrain' present; full target unverified — ` +
              `\`${listBin} mcp get gbrain\` to inspect).`,
          );
        } else {
          console.log(`MCP registration submitted; could not confirm via \`${listBin} mcp list\` (best-effort probe).`);
        }
      }
    } catch {
      /* smoke is best-effort */
    }

    // 3. Hooks (Claude Code only, consent-gated).
    let hooksWritten = false;
    if (harness === 'claude-code') {
      if (hooksConsent) {
        const r = writeClaudeHooks(ws, {
          gbrainBin,
          env: { GBRAIN_SOURCE: sourceId, ...(gbrainHome ? { GBRAIN_HOME: gbrainHome } : {}) },
        });
        hooksWritten = true;
        console.log(`hooks installed (${r.installed.length} event(s)) in ${r.settingsPath}${repair ? ' [repair]' : ''} — your brain now loads every turn. Turn off any time with GBRAIN_HOOKS=0, or re-run with --no-hooks.`);
        for (const note of r.notes) console.error(note);
      } else {
        console.log(
          noHooks
            ? 'hooks skipped (--no-hooks) — the AGENTS.md pull protocol covers per-turn context instead; re-enable with `gbrain bootstrap hooks --harness claude-code`.'
            : 'hooks declined (HOOKS_CONSENT set to no) — the AGENTS.md pull protocol covers per-turn context instead; re-enable with `gbrain bootstrap hooks --harness claude-code`.',
        );
      }
    } else {
      console.log('Codex has no hook system — per-turn context is the AGENTS.md pull protocol (stated plainly, not a bug).');
    }

    // 4. Receipt registration record [CX2-12].
    appendReceiptRegistration(home, ws, {
      host: harness,
      scope: harness === 'claude-code' ? mcpScope : 'user',
      detail: hooksWritten ? 'mcp+hooks' : 'mcp',
    });

    abortIfInjected('wire');
    return 0;
  });
}

async function runVerify(ws: string, rest: string[], home: string): Promise<number> {
  const jsonMode = rest.includes('--json');
  const cfg = loadConfig();
  if (!cfg) {
    console.error('no brain configured — run `gbrain init --pglite` first (the engine phase).');
    console.error(SUPPORT_HINT);
    return 1;
  }
  // verify manages its own engine (commands/cache.ts pattern) — it must be
  // importable while the rest of the bootstrap family stays engine-free.
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    const state = readManifest(ws);
    const sourceId = state.state === 'initialized' ? state.manifest.source_id : 'workspace';
    const result = await verifyWorkspace(engine, ws, { sourceId, gbrainHomeDir: home });
    if (jsonMode) {
      console.log(JSON.stringify({ ok: result.ok, checks: result.checks, capability: result.capability, tour: result.tour }, null, 2));
    } else {
      console.log(result.report);
    }
    abortIfInjected('verify');
    return result.ok ? 0 : 1;
  } finally {
    try {
      await engine.disconnect();
    } catch {
      /* best effort */
    }
  }
}

async function runAttach(ws: string, rest: string[], home: string): Promise<number> {
  const harness = (flagValue(rest, '--harness') as Harness | undefined) ?? detectHarness() ?? 'claude-code';
  return withLock(ws, async () => {
    const res = attachWorkspace(ws, { harness, gbrainHomeDir: home, createdBy: `gbrain@${VERSION}` });
    abortIfInjected('attach');
    console.log(`attached workspace for agent "${res.manifest.agent_name}" (source '${res.manifest.source_id}'). Receipt written.`);
    console.log('\nRemaining steps (attach validates + records; run these next):');
    const brainDir = join(ws, 'brain');
    const commands: Record<string, string> = {
      register_source: `gbrain sources add ${res.manifest.source_id} --path ${brainDir}`,
      hooks_repair: `gbrain bootstrap hooks --harness ${harness} --repair`,
      mcp_add: `(covered by the hooks step — MCP registration rides it)`,
      verify: 'gbrain bootstrap verify',
    };
    res.steps.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.description}`);
      console.log(`     → ${commands[s.kind] ?? ''}`);
    });
    return 0;
  });
}

/** Engine-free brain stats for the --delete-brain confirm text: counts the
 * write-through .md files under `<ws>/brain` (the committed mirror of the DB —
 * a floor, since DB-only pages have no file) and names the workspace source
 * from the manifest. Never opens the engine (uninstall must work while a live
 * serve holds the PGLite lock refusal path). Exported for direct tests. */
export function workspaceBrainStats(ws: string): { sources: string[]; pages: number } | null {
  const brainDir = join(ws, 'brain');
  let pages = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.md')) pages++;
    }
  };
  try {
    walk(brainDir, 0);
  } catch {
    return null; // no brain/ dir readable — the module falls back to its receipt-only text
  }
  const manifest = readManifest(ws);
  const sources = manifest.state === 'initialized' ? [manifest.manifest.source_id] : ['workspace'];
  return { sources, pages };
}

async function runUninstall(ws: string, rest: string[], home: string, runner: ExecRunner): Promise<number> {
  const deleteBrain = rest.includes('--delete-brain');
  const yes = rest.includes('--yes');
  const homeFlag = flagValue(rest, '--home');
  return withLock(ws, async () => {
    if (deleteBrain) {
      // Facts-export offer BEFORE any deletion can run — facts are user
      // knowledge, not derived state; after the rm there is nothing to export.
      console.log(
        'offered: export facts before deletion (`gbrain facts export`) — the brain DB is about to be removed and facts are not derived state',
      );
    }
    const result = await uninstallWorkspace(ws, {
      deleteBrain,
      ...(yes ? { confirm: async () => true } : {}),
      gbrainHomeDir: homeFlag ? resolve(homeFlag) : home,
      homeExplicit: homeFlag !== undefined,
      brainStats: async () => workspaceBrainStats(ws),
    });

    // Execute the structured host-registration removals the module returned.
    for (const reg of result.registration_removals) {
      if (reg.host === 'claude-code') {
        const r = removeClaudeHooks(ws);
        if (r.removed > 0) console.log(`removed ${r.removed} gbrain hook entr${r.removed === 1 ? 'y' : 'ies'} from ${r.settingsPath}`);
        for (const note of r.notes) console.error(note);
        const rm = await runner(['claude', 'mcp', 'remove', 'gbrain']);
        if (rm.code !== 0) console.error('note: `claude mcp remove gbrain` did not succeed — remove it by hand if it lingers.');
      } else {
        const rm = await runner(['codex', 'mcp', 'remove', 'gbrain']);
        if (rm.code !== 0) console.error('note: `codex mcp remove gbrain` did not succeed — remove it by hand if it lingers.');
      }
    }

    // The facts-export offer already printed BEFORE deletion (above); don't
    // repeat it after the brain is gone.
    for (const step of result.steps) {
      if (step.kind === 'facts_export_offer') continue;
      console.log(`offered: ${step.description}`);
    }
    console.log(`removed paths: ${result.removed_paths.join(', ') || '(none)'}`);
    for (const s of result.skipped_paths) console.log(`kept ${s.path} (${s.reason})`);
    console.log(`brain ${result.brain_deleted ? 'DELETED' : 'kept'}; receipt ${result.receipt_removed ? 'consumed' : 'kept'}.`);
    console.log('The workspace repo and its files remain yours — the body is portable by design.');
    abortIfInjected('uninstall');
    return 0;
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface RunBootstrapOpts {
  /** Exec seam for gh/claude/codex subprocesses (tests inject a recorder). */
  runner?: ExecRunner;
}

/** Dispatch. Returns the process exit code (cli.ts passes it to setCliExitVerdict). */
export async function runBootstrap(args: string[], opts: RunBootstrapOpts = {}): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(BOOTSTRAP_HELP);
    return 0;
  }
  const rest = args.slice(1);
  const ws = resolveWorkspace(rest);
  const home = resolveGbrainHome();
  const runner = opts.runner ?? defaultRunner;
  const harnessForLog = flagValue(rest, '--harness') ?? detectHarness() ?? undefined;
  const logCtx: LogCtx = { home, ws, ...(harnessForLog ? { harness: harnessForLog } : {}) };
  const t0 = Date.now();

  const KNOWN = new Set(['status', 'interview', 'render', 'repo', 'hooks', 'verify', 'attach', 'uninstall']);
  if (!KNOWN.has(sub)) {
    console.error(`unknown subcommand: ${sub}`);
    console.error(BOOTSTRAP_HELP);
    return 2;
  }

  // The install log records the PHASE name, and the hooks subcommand is the
  // 'wire' phase (status.ts phase list) — one mapping, used at every log site.
  const logPhaseName = sub === 'hooks' ? 'wire' : sub;

  try {
    let code: number;
    switch (sub) {
      case 'status':
        // status is the read surface — it does not log itself into install.jsonl.
        return await runStatus(ws, rest, home);
      case 'interview':
        code = await runInterview(ws, rest);
        break;
      case 'render':
        code = await runRender(ws, rest, home);
        break;
      case 'repo':
        code = await runRepo(ws, rest, home, runner);
        break;
      case 'hooks':
        code = await runHooks(ws, rest, home, runner);
        break;
      case 'verify':
        code = await runVerify(ws, rest, home);
        break;
      case 'attach':
        code = await runAttach(ws, rest, home);
        break;
      case 'uninstall':
        code = await runUninstall(ws, rest, home, runner);
        break;
      default:
        return 2; // unreachable
    }
    logPhase(logCtx, logPhaseName, code === 0 ? 'ok' : 'error', t0);
    return code;
  } catch (e) {
    if (e instanceof BootstrapAbortInjected) {
      // [A7] Simulated kill: artifacts from the phase exist, the finalize
      // (install log 'ok' line) never ran — exactly the crash shape status
      // must resume from. The log records the abort for the post-mortem.
      logPhase(logCtx, logPhaseName, 'aborted', t0);
      console.error(e.message);
      return 130;
    }
    if (e instanceof BootstrapError) {
      console.error(e.message);
      console.error(SUPPORT_HINT);
      logPhase(logCtx, logPhaseName, 'error', t0);
      return e.exitCode;
    }
    if (e instanceof BootstrapRenderError) {
      console.error(e.message);
      console.error(SUPPORT_HINT);
      logPhase(logCtx, logPhaseName, 'error', t0);
      return 1;
    }
    console.error(`bootstrap ${sub} failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(SUPPORT_HINT);
    logPhase(logCtx, logPhaseName, 'error', t0);
    return 1;
  }
}

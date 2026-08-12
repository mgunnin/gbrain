/**
 * hook.ts — `gbrain hook <event>`: the harness-side hook command
 * (agent-bootstrap plan: D5, A3, A9, G3, G4, G15, B3, B4, ENG-1, S3#2,
 * S3#7, S3#8).
 *
 * ENGINE-FREE BY CONSTRUCTION (plan D5): `gbrain serve` holds the PGLite
 * single-writer lock for its lifetime, so this command NEVER imports an
 * engine or connectEngine — config comes from `loadConfig()` only, per-turn
 * context comes from serve's resolve-IPC unix socket (requestTurnContext),
 * and everything else is plain file reads/writes. Registered in cli.ts's
 * no-engine dispatch branch (CLI_ONLY + handleCliOnly, before the
 * connectEngine terminator) and must never enter THIN_CLIENT_REFUSED
 * [ENG-2].
 *
 * FAIL-OPEN CONTRACT: a hook failure must never break the user's session.
 * Every event exits 0 (empty stdout on failure) and records a heartbeat
 * line; only a CLI usage error (unknown event) exits non-zero. The
 * `GBRAIN_HOOKS=0` env kill switch short-circuits every event.
 *
 * HEARTBEAT [S3#7, B3]: append-JSONL at
 * `<gbrain home>/integrations/hooks/heartbeat.jsonl` — counters, durations,
 * and error CODES only, never prompt/fact/slug text. Dir 0700, file capped
 * at HEARTBEAT_MAX_LINES (tail-rewrite). `readHeartbeatTail` is the
 * doctor/status read surface.
 *
 * Events:
 *   session-start  digest to stdout from FILE reads only (≤1.5s) [A3,G4,B3,B4]
 *   user-prompt    stdin hook JSON → IPC turn_context → additionalContext
 *                  JSON on stdout (≤800ms, ≤10000 chars) [ENG-1,S3#8,A9]
 *   stop           append to the per-session live buffer + 7-day GC [G15]
 *   session-end    transcript → secret-scanned corpus file, retention prune,
 *                  parser-drift detection, detached background workspace push
 *                  [S3#2,G3,G15]
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { ensureGbrainHome, resolveGbrainHome } from '../core/gbrain-home.ts';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import {
  IPC_UNAVAILABLE,
  readIpcSecret,
  requestTurnContext,
  resolveSocketPath,
  type TurnContextResponse,
} from '../core/context/resolve-ipc.ts';
import type { WindowTurn } from '../core/context/entity-salience.ts';
import {
  confineTranscriptPath,
  parseTranscript,
  toCorpusText,
} from '../core/transcripts/claude-code-jsonl.ts';
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../core/bootstrap/host-specs.ts';
import { readManifest, readReceipt, type InstallReceipt } from '../core/bootstrap/format.ts';
import { realpathOrResolve } from '../core/path-confine.ts';

// ── Tunables ────────────────────────────────────────────────────────────────

/** session-start self-deadline (plan D5). */
export const SESSION_START_DEADLINE_MS = 1500;
/** user-prompt hard self-deadline (plan D5/ENG-1). */
export const USER_PROMPT_DEADLINE_MS = 800;
/** MEMORY.md digest budget [A3]. */
export const DIGEST_MEMORY_CAP_BYTES = 3072;
/** Digest-eligible MEMORY.md sections [A3] — matched case-insensitively. */
export const DIGEST_SECTIONS = ['standing rules', 'open commitments', 'active context'];
/** Stop-buffer retention [G15]. */
export const STOP_BUFFER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Default corpus retention when `dream.synthesize.corpus_retention_days` is unset [G15]. */
export const CORPUS_RETENTION_DAYS_DEFAULT = 30;
/**
 * Sweep sidecar suffixes — DUPLICATED from sweep.ts on purpose: hook.ts is
 * engine-free by construction (module header D5), and sweep.ts eagerly imports
 * capability.ts, so a value-import here would drag that in. A corpus (re)write
 * MUST invalidate any prior completion/claim marker so the serve sweep
 * re-ingests the appended transcript of a resumed session (otherwise the new
 * turns are skipped forever). Keep these in sync with sweep.ts's
 * CORPUS_INGESTED_SUFFIX / CORPUS_CLAIM_SUFFIX.
 */
export const CORPUS_INGESTED_SUFFIX = '.ingested';
export const CORPUS_CLAIM_SUFFIX = '.in-progress';
/** Heartbeat file line cap [S3#7]. */
export const HEARTBEAT_MAX_LINES = 5000;
/** Trailing-window size for the B3 failure-rate notice. */
export const HEARTBEAT_FAILURE_WINDOW = 20;
/**
 * Trailing-window hard-error rate that trips the B3 digest notice AND the
 * doctor `bootstrap_hooks_heartbeat` fail (doctor imports this — one source).
 */
export const HEARTBEAT_FAILURE_RATE_THRESHOLD = 0.5;
/** Push-staleness threshold [B4] — shared with doctor's bootstrap_push_health. */
export const PUSH_STALE_MS = 48 * 60 * 60 * 1000;
/** user-prompt window: transcript turns fed to turn_context (plan D5: last 4). */
const USER_PROMPT_WINDOW_TURNS = 4;
/** Dedupe-input budget: newest injected blocks kept under this cap so the
 * IPC request can never blow the 256KB message cap on priorContextText. */
export const PRIOR_CONTEXT_MAX_BYTES = 32 * 1024;
/** user-prompt transcript parse budget (tail bytes — the window only needs the newest turns). */
const USER_PROMPT_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

// ── Test seam ───────────────────────────────────────────────────────────────

/**
 * In-process I/O seam. The CLI wiring calls `runHook(args)` with none of
 * these set; tests inject stdin/stdout/cwd (and a transcript confinement
 * root) so the full stdin→stdout contract runs without subprocesses.
 * `transcriptRoot` is intentionally NOT env-configurable — the S3#8
 * confinement root must not be widenable by whatever spawned the hook.
 */
export interface HookIo {
  /** Injected stdin body; undefined → read process.stdin (non-TTY only). */
  stdin?: string;
  /** Injected stdout sink; default process.stdout.write. */
  write?: (s: string) => void;
  /** Workspace dir override; default stdin JSON `cwd` → process.cwd(). */
  cwd?: string;
  /** TEST SEAM: transcript confinement root (default ~/.claude/projects). */
  transcriptRoot?: string;
  /**
   * TEST SEAM: detached-push spawner (default spawnDetachedPush). Receives the
   * gated bootstrap workspace root; throwing marks the push unavailable.
   */
  spawnPush?: (root: string) => void;
  /** TEST SEAM: user-prompt deadline override (wall-clock flake control). */
  userPromptDeadlineMs?: number;
  /**
   * Feedback-loop attribution channel (`--harness <claude-code|codex>`).
   * Default 'claude-code' — the only harness bootstrap registers hooks for
   * today; a codex hook registration passes the flag explicitly.
   */
  harness?: 'claude-code' | 'codex';
}

// ── Entry point ─────────────────────────────────────────────────────────────

const USAGE = `Usage: gbrain hook <event>

Events (wired into .claude/settings.local.json by gbrain bootstrap):
  session-start   print the greeting digest (MEMORY.md sections, last session,
                  push status, hook health) to stdout
  user-prompt     read hook JSON on stdin, request per-turn context from a
                  running 'gbrain serve' over IPC, print additionalContext JSON
                  (--harness <claude-code|codex> sets the feedback-loop channel;
                  default claude-code, unknown values fall back to the default)
  stop            append to the per-session live buffer
  session-end     ingest the session transcript into the dream corpus
                  (secret-scanned), prune old corpus files, push the workspace

Env: GBRAIN_HOOKS=0 disables all events (immediate exit 0).
All events fail open: errors exit 0 with empty stdout and a heartbeat entry at
<gbrain home>/integrations/hooks/heartbeat.jsonl.`;

/** Dispatch a hook event. Returns the process exit code (0 for every runtime path). */
export async function runHook(args: string[], io: HookIo = {}): Promise<number> {
  const event = args[0];
  if (event === '--help' || event === '-h' || event === 'help') {
    write(io, USAGE + '\n');
    return 0;
  }
  // `--harness <claude-code|codex>` — feedback-loop channel attribution for
  // user-prompt. Unknown values fall back to the default (fail-open: a bad
  // registration must never break the hook contract).
  const harnessIdx = args.indexOf('--harness');
  if (harnessIdx >= 0 && !io.harness) {
    const v = args[harnessIdx + 1];
    if (v === 'claude-code' || v === 'codex') io = { ...io, harness: v };
  }
  if (!event || !['session-start', 'user-prompt', 'stop', 'session-end'].includes(event)) {
    process.stderr.write(USAGE + '\n');
    return 1;
  }
  // Kill switch — before any file/socket touch, no heartbeat (the user asked
  // for silence, and a disabled hook writing telemetry would be a lie).
  if (process.env.GBRAIN_HOOKS === '0') return 0;

  switch (event) {
    case 'session-start':
      return hookSessionStart(io);
    case 'user-prompt':
      return hookUserPrompt(io);
    case 'stop':
      return hookStop(io);
    case 'session-end':
      return hookSessionEnd(io);
    default:
      return 1; // unreachable
  }
}

// ── Shared plumbing ─────────────────────────────────────────────────────────

function write(io: HookIo, s: string): void {
  if (io.write) io.write(s);
  else process.stdout.write(s);
}

const DEADLINE: unique symbol = Symbol('deadline');

function withDeadline<T>(ms: number, work: Promise<T>): Promise<T | typeof DEADLINE> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(DEADLINE), ms);
    (t as { unref?: () => void }).unref?.();
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(DEADLINE); // caller treats a rejection like a timeout: fail-open
      },
    );
  });
}

/** Read stdin (or the injected seam) and JSON-parse; null on anything else. */
async function readStdinJson(io: HookIo, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let raw: string;
  if (io.stdin !== undefined) {
    raw = io.stdin;
  } else {
    raw = await readProcessStdin(timeoutMs);
  }
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readProcessStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(buf);
    };
    const t = setTimeout(finish, timeoutMs);
    (t as { unref?: () => void }).unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      buf += c;
      if (buf.length > 4 * 1024 * 1024) finish(); // hook payloads are small — cap defensively
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * Gbrain home resolver: the S3#10 choke point, statically imported [CX2-8].
 * Only the CALL is guarded — ensureGbrainHome throws solely when the create
 * fails, and resolveGbrainHome (pure path resolution, same semantics) is the
 * fail-open fallback; downstream writers under an uncreatable home fail into
 * their own swallow-and-heartbeat paths.
 */
async function resolveHome(): Promise<string> {
  try {
    return ensureGbrainHome();
  } catch {
    return resolveGbrainHome();
  }
}

function ensureDir0700(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  return dir;
}

function sanitizeSessionId(id: unknown): string {
  const s = typeof id === 'string' ? id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) : '';
  return s && !/^\.+$/.test(s) ? s : 'unknown';
}

/** Reason strings must be CODES [S3#7] — clamp anything message-shaped. */
function reasonCode(reason: string): string {
  return /^[A-Za-z0-9_.:-]{1,48}$/.test(reason) ? reason : 'server_error';
}

function errorCode(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : typeof e;
  return reasonCode(`exception:${name}`);
}

// ── Heartbeat [S3#7, B3] ────────────────────────────────────────────────────

export interface HookHeartbeatEntry {
  ts: string;
  event: string;
  outcome: 'ok' | 'degraded' | 'error';
  reason?: string;
  duration_ms: number;
  turns?: number;
  bytes?: number;
  /** Secret-scan redaction COUNT at the session-end corpus write (never content) [S3#2, S3#7]. */
  redactions?: number;
}

/** The FULL key allowlist — CI greps the fixture against this [S3#7]. */
export const HEARTBEAT_ALLOWED_KEYS = [
  'ts', 'event', 'outcome', 'reason', 'duration_ms', 'turns', 'bytes', 'redactions',
] as const;

async function hooksTelemetryDir(): Promise<string> {
  const home = await resolveHome();
  ensureDir0700(join(home, 'integrations'));
  return ensureDir0700(join(home, 'integrations', 'hooks'));
}

/** Heartbeat JSONL path (exported for doctor/status/tests). */
export async function heartbeatPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'heartbeat.jsonl');
}

/** Status file the session-end parser-drift check writes [G3]. */
export async function hookStatusPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'status.json');
}

/**
 * Compaction trigger: only read the file back when its byte size could hold
 * more than ~2x HEARTBEAT_MAX_LINES entries. 40B is below any real entry's
 * size (the ISO ts alone is 24 chars), so this check can never UNDER-trigger.
 */
const HEARTBEAT_COMPACT_CHECK_BYTES = 2 * HEARTBEAT_MAX_LINES * 40;

/**
 * Append a heartbeat entry with a single O_APPEND write (no read-modify-write
 * per event — readers already tolerate torn lines). Compaction (tail-trim to
 * HEARTBEAT_MAX_LINES via tmp+rename) runs only when a cheap size/line-count
 * check says the file exceeds ~2x the cap. Fields are copied EXPLICITLY — the
 * schema allowlist is enforced by construction, not by trust. Never throws.
 */
async function writeHeartbeat(entry: HookHeartbeatEntry): Promise<void> {
  try {
    const p = await heartbeatPath();
    const line = JSON.stringify({
      ts: entry.ts,
      event: entry.event,
      outcome: entry.outcome,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      duration_ms: entry.duration_ms,
      ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
      ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
      ...(entry.redactions !== undefined ? { redactions: entry.redactions } : {}),
    });
    appendFileSync(p, line + '\n', { mode: 0o600 });
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      /* just appended — best effort */
    }
    if (size > HEARTBEAT_COMPACT_CHECK_BYTES) {
      const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      if (lines.length > 2 * HEARTBEAT_MAX_LINES) {
        const tmp = `${p}.tmp-${process.pid}`;
        writeFileSync(tmp, lines.slice(-HEARTBEAT_MAX_LINES).join('\n') + '\n', { mode: 0o600 });
        renameSync(tmp, p);
      }
    }
  } catch {
    /* telemetry never breaks a hook */
  }
}

/** Last `n` heartbeat entries (oldest → newest). Doctor/status read surface. */
export async function readHeartbeatTail(n: number): Promise<HookHeartbeatEntry[]> {
  try {
    const p = await heartbeatPath();
    const raw = readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const out: HookHeartbeatEntry[] = [];
    for (const line of lines.slice(-Math.max(0, n))) {
      try {
        out.push(JSON.parse(line) as HookHeartbeatEntry);
      } catch {
        /* torn line — skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── session-start [A3, G4, B3, B4] ──────────────────────────────────────────

async function hookSessionStart(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  const out: string[] = [];

  try {
    const j = await readStdinJson(io, 250);
    const ws = io.cwd ?? (typeof j?.cwd === 'string' ? (j.cwd as string) : process.cwd());

    const work = (async () => {
      // 1. MEMORY.md digest — allowlisted sections only, ≤3KB [A3].
      const digest = memoryDigest(join(ws, 'MEMORY.md'));
      if (digest) out.push(digest);

      // 2. Last-session line from the stop-buffer dir [G15 consumer].
      const last = await lastSessionLine();
      if (last) out.push(last);

      // 3. Push staleness [B4].
      const pushNote = await pushStatusNote();
      if (pushNote) out.push(pushNote);

      // 4. Visible degradation [B3] + parser-drift status file [G3].
      const failNote = await hookFailureNotice();
      if (failNote) out.push(failNote);
      const statusNote = await statusFileNotice();
      if (statusNote) out.push(statusNote);

      // 5. Dirty-tree recovery push [G4] — bootstrap workspaces ONLY (the
      //    initialized agent.json manifest is the gate; `gbrain hook
      //    session-start` run in an arbitrary repo must never commit it).
      //    The push itself runs as a detached child; the hook only spawns.
      const dirty = await dirtyTreePush(ws, io);
      if (dirty) {
        if (dirty.note) out.push(dirty.note);
        if (dirty.reason && outcome === 'ok') {
          if (dirty.degraded) outcome = 'degraded';
          reason = reasonCode(dirty.reason);
        }
      }
    })();

    const res = await withDeadline(SESSION_START_DEADLINE_MS, work);
    if (res === DEADLINE && outcome === 'ok') {
      outcome = 'degraded';
      reason = 'deadline';
    }
    // Print whatever accumulated before the deadline — a partial digest
    // beats an empty one (the deadline bounds latency, not usefulness).
    const text = out.filter(Boolean).join('\n\n');
    if (text) write(io, text + '\n');
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e); // fail-open: empty stdout, exit 0
  }
  await writeHeartbeat({
    ts: new Date().toISOString(),
    event: 'session-start',
    outcome,
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
  });
  return 0;
}

/**
 * Extract the digest-eligible sections from MEMORY.md [A3]. Only headings in
 * DIGEST_SECTIONS qualify — the template's security-boundary note and every
 * other section stay out of injected context. Capped at
 * DIGEST_MEMORY_CAP_BYTES.
 */
export function memoryDigest(memoryPath: string): string | null {
  let raw: string;
  try {
    const st = statSync(memoryPath);
    if (!st.isFile() || st.size > 512 * 1024) return null; // malformed/huge — skip
    raw = readFileSync(memoryPath, 'utf8');
  } catch {
    return null;
  }
  const picked: string[] = [];
  let inSection = false;
  for (const line of raw.split('\n')) {
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      inSection = DIGEST_SECTIONS.includes(h[2].trim().toLowerCase());
      if (inSection) picked.push(line);
      continue;
    }
    if (inSection) picked.push(line);
  }
  const body = picked.join('\n').trim();
  if (!body) return null;
  let text = `From MEMORY.md:\n${body}`;
  if (Buffer.byteLength(text, 'utf8') > DIGEST_MEMORY_CAP_BYTES) {
    const cut = Buffer.from(text, 'utf8').subarray(0, DIGEST_MEMORY_CAP_BYTES - 2).toString('utf8');
    text = cut.replace(/�+$/, '') + '…';
  }
  return text;
}

async function liveBufferDir(): Promise<string> {
  const home = await resolveHome();
  ensureDir0700(join(home, 'transcripts'));
  return ensureDir0700(join(home, 'transcripts', 'live'));
}

async function lastSessionLine(): Promise<string | null> {
  try {
    const dir = await liveBufferDir();
    let newest: { path: string; mtime: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (!newest || st.mtimeMs > newest.mtime) newest = { path: p, mtime: st.mtimeMs };
    }
    if (!newest) return null;
    const lines = readFileSync(newest.path, 'utf8').split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last) return null;
    try {
      const e = JSON.parse(last) as { ts?: string; exchange?: string };
      const snippet = typeof e.exchange === 'string' ? ` — ${e.exchange.slice(0, 200)}` : '';
      return `Last session activity: ${e.ts ?? 'unknown time'}${snippet}`;
    } catch {
      return `Last session activity: ${last.slice(0, 200)}`;
    }
  } catch {
    return null;
  }
}

async function pushStatusNote(): Promise<string | null> {
  try {
    const home = await resolveHome();
    const p = join(home, 'bootstrap', 'push-status.json');
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, 'utf8')) as { ts?: string; ok?: boolean; reason?: string };
    if (s.ok === false) {
      return `Workspace push is FAILING (since ${s.ts ?? 'unknown'}): ${s.reason ?? 'unknown reason'} — run gbrain doctor`;
    }
    const t = s.ts ? Date.parse(s.ts) : NaN;
    if (Number.isFinite(t) && Date.now() - t > PUSH_STALE_MS) {
      return `Workspace push: last success ${s.ts} (>48h ago) — recent work may be unpushed [B4]`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * [B3] Visible degradation: when >50% of the trailing-20 heartbeat entries
 * are hard errors, say so in the digest. Degraded entries (pull-mode
 * no_serve, stale_serve, …) are DESIGNED fallbacks and don't count — the
 * notice is for broken, not for absent.
 */
async function hookFailureNotice(): Promise<string | null> {
  const tail = await readHeartbeatTail(HEARTBEAT_FAILURE_WINDOW);
  if (tail.length === 0) return null;
  const failures = tail.filter((e) => e.outcome === 'error').length;
  if (failures / tail.length > HEARTBEAT_FAILURE_RATE_THRESHOLD) {
    return 'brain context unavailable for recent turns — run gbrain doctor';
  }
  return null;
}

const STATUS_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function statusFileNotice(): Promise<string | null> {
  try {
    const p = await hookStatusPath();
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, 'utf8')) as { ts?: string; error?: string };
    const t = s.ts ? Date.parse(s.ts) : NaN;
    if (!Number.isFinite(t) || Date.now() - t > STATUS_NOTICE_MAX_AGE_MS) return null;
    return `Hook alert: ${s.error ?? 'unknown'} (${s.ts}) — transcript ingestion may be broken; run gbrain doctor`;
  } catch {
    return null;
  }
}

/** Per-git-command timeout for hook quick checks (bounds the child; the event loop stays free). */
const HOOK_GIT_TIMEOUT_MS = 1000;

/**
 * Async execFile wrapper: the hook push paths must NEVER block the event
 * loop with execFileSync — a slow repo/network would keep withDeadline's
 * timer from ever firing and stall the harness for minutes. null on any
 * failure (missing binary, non-zero exit, timeout).
 */
function tryExecAsync(bin: string, args: string[], timeoutMs = HOOK_GIT_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : stdout.toString().trim()),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Resolve the bootstrap workspace root for a hook event: the git toplevel of
 * `ws`, gated on an `initialized` agent.json manifest at that root. The gate
 * is the security boundary — `gbrain hook <event>` run in an arbitrary repo
 * must never commit or push it. Shared by session-start and session-end.
 */
async function resolveBootstrapWorkspaceRoot(ws: string): Promise<string | null> {
  const root = await tryExecAsync('git', ['-C', ws, 'rev-parse', '--show-toplevel']);
  if (!root) return null;
  const manifest = readManifest(root);
  if (manifest.state !== 'initialized') return null; // not a bootstrap workspace
  return root;
}

/** owner/name from a github https/ssh remote URL, or null. Local mirror of
 * repo.ts's parser (kept here so the engine-free hook doesn't import repo.ts). */
function githubOwnerName(url: string): string | null {
  const m =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The no-daemon workspace push must NOT fire until the repo phase has verified
 * the origin's privacy and recorded `repo_url`. In a create-repo-first install
 * the origin exists (the clone) BEFORE the repo phase, and hooks are wired one
 * phase earlier — so an ungated session-end/recovery push could publish
 * workspace content to an as-yet-unverified (possibly public) remote. A recorded
 * `repo_url` means the repo phase completed against a verified-private remote.
 *
 * Bound to the recorded repo: the current origin — BOTH the fetch URL and the
 * push URL (`git push` uses the push URL when set) — must still resolve to the
 * same owner/name as `repo_url`, so a later `git remote set-url` can't redirect
 * the push to another (possibly public) repo. No receipt / no repo_url / a
 * changed origin → defer (fail-closed).
 */
async function repoPhaseComplete(root: string): Promise<boolean> {
  try {
    const receipt = readReceipt(resolveGbrainHome()) as (InstallReceipt & { repo_url?: string }) | null;
    if (!receipt || typeof receipt.repo_url !== 'string' || receipt.repo_url.length === 0) return false;
    if (realpathOrResolve(receipt.workspace_dir) !== realpathOrResolve(root)) return false;
    const want = githubOwnerName(receipt.repo_url);
    if (!want) return false;
    const fetchUrl = await tryExecAsync('git', ['-C', root, 'remote', 'get-url', 'origin']);
    if (githubOwnerName(fetchUrl ?? '') !== want) return false;
    // Push URL (remote.origin.pushurl) via the config key directly (no dash-flag):
    // unset → `git push` uses the fetch URL (already matched). Only a configured
    // push URL that points elsewhere blocks the push.
    const pushUrl = await tryExecAsync('git', ['-C', root, 'config', 'remote.origin.pushurl']);
    return !pushUrl || githubOwnerName(pushUrl) === want;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget `gbrain sources push --path <root>` as a DETACHED child.
 * workspacePush must never run inline in a hook — its git chain is fully
 * synchronous (execFileSync) and would block the event loop past every
 * deadline. The child owns the push lock/status plumbing; the hook only
 * announces it. Throws when the child can't be spawned (caller degrades).
 */
function spawnDetachedPush(root: string): void {
  const exec = process.execPath ?? '';
  const pushArgs = ['sources', 'push', '--path', root];
  // Compiled binary: execPath IS gbrain. Dev (bun src/cli.ts): re-exec the
  // entrypoint — the jobs.ts --detach precedent.
  const argv = /[/\\]gbrain(\.exe)?$/.test(exec) ? pushArgs : [process.argv[1], ...pushArgs];
  const child = spawn(exec, argv, { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * [G4] Crashed-session recovery: dirty tree or unpushed commits at session
 * start → spawn the workspace push in the background (never inline). GATED
 * on the initialized-manifest bootstrap workspace root (the security
 * boundary — see resolveBootstrapWorkspaceRoot).
 */
async function dirtyTreePush(
  ws: string,
  io: HookIo,
): Promise<{ note?: string; reason?: string; degraded?: boolean } | null> {
  try {
    const root = await resolveBootstrapWorkspaceRoot(ws);
    if (!root) return null;
    const [status, aheadRaw] = await Promise.all([
      tryExecAsync('git', ['-C', root, 'status', '--porcelain']),
      tryExecAsync('git', ['-C', root, 'rev-list', '--count', '@{u}..HEAD']),
    ]);
    const dirty = (status ?? '') !== '';
    const ahead = aheadRaw !== null ? parseInt(aheadRaw, 10) || 0 : 0;
    if (!dirty && ahead === 0) return null; // clean + up to date → nothing to recover
    // There IS unpushed work. Defer until the repo phase verified privacy +
    // recorded repo_url — never recover-push to an unverified origin
    // (create-repo-first race). Only fires when work actually exists (P2-1).
    if (!(await repoPhaseComplete(root))) {
      return {
        note: 'Unpushed work detected; will push after the repo phase completes (`gbrain bootstrap repo`).',
        reason: 'push_deferred_repo_pending',
      };
    }
    try {
      (io.spawnPush ?? spawnDetachedPush)(root);
      return {
        note: 'Unpushed work from a previous session detected — recovering unpushed work in background (gbrain sources push).',
        reason: 'push_spawned',
      };
    } catch {
      return {
        note: 'Unpushed work from a previous session detected; automatic push unavailable — run gbrain doctor',
        reason: 'push_unavailable',
        degraded: true,
      };
    }
  } catch {
    return null;
  }
}

// ── user-prompt [ENG-1, S3#8, A9] ───────────────────────────────────────────

interface UserPromptOutcome {
  outcome: HookHeartbeatEntry['outcome'];
  reason?: string;
  turns?: number;
}

async function hookUserPrompt(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let expired = false;
  const guardedWrite = (s: string) => {
    if (!expired) write(io, s);
  };

  const work = (async (): Promise<UserPromptOutcome> => {
    const j = await readStdinJson(io, 300);
    if (!j) return { outcome: 'degraded', reason: 'no_stdin' };

    // S3#8: transcript_path is untrusted input. A present-but-unconfined
    // path aborts the event (heartbeat + empty stdout), never "best effort".
    let turns: WindowTurn[] = [];
    let priorContextText: string | undefined;
    if (j.transcript_path !== undefined && j.transcript_path !== null) {
      const conf = confineTranscriptPath(j.transcript_path, {
        ...(io.transcriptRoot ? { root: io.transcriptRoot } : {}),
      });
      if (!conf.ok) return { outcome: 'degraded', reason: `transcript_${conf.reason}` };
      try {
        const parsed = parseTranscript(conf.path, { maxBytes: USER_PROMPT_TRANSCRIPT_MAX_BYTES });
        turns = parsed.turns.slice(-USER_PROMPT_WINDOW_TURNS);
        // Cross-turn dedupe: feed the blocks WE previously injected this
        // session back as priorContextText (slug-only suppression + volunteer
        // dedupe inside assembleTurnContext) — a page is volunteered once per
        // session, not once per mention. Structured extraction only (the
        // gbrain-marked hook_additional_context attachments), never raw turn
        // text, so a short slug in a tool payload can't over-suppress.
        // Bounded before send: identical blocks dedupe (the same pointer
        // re-recorded each turn is pure redundancy) and the newest blocks are
        // kept under a byte cap — an unbounded join would eventually exceed
        // the 256KB IPC message cap and permanently silence the channel.
        // Horizon note: the tail read bounds dedupe to the newest
        // USER_PROMPT_TRANSCRIPT_MAX_BYTES of transcript — in very long
        // sessions the oldest injections roll out and their pages become
        // volunteerable again (documented, preferable to a state file).
        if (parsed.injectedContextBlocks.length) {
          const unique = [...new Set(parsed.injectedContextBlocks)];
          const kept: string[] = [];
          let bytes = 0;
          for (const block of unique.reverse()) { // newest first
            const b = Buffer.byteLength(block, 'utf8') + 2;
            // Skip (not break): one oversized block must not evict every
            // older, smaller block — that would disable ALL dedupe at once.
            if (bytes + b > PRIOR_CONTEXT_MAX_BYTES) continue;
            kept.unshift(block); // restore oldest → newest order
            bytes += b;
          }
          if (kept.length) priorContextText = kept.join('\n\n');
        }
      } catch {
        turns = []; // unreadable-mid-flight — the prompt alone still works
      }
    }
    const prompt = typeof j.prompt === 'string' ? j.prompt : '';
    if (prompt.trim()) turns = [...turns, { role: 'user', text: prompt }];
    if (turns.length === 0) return { outcome: 'ok', reason: 'empty_window' };

    const cfg = loadConfig();
    if (!cfg?.database_path) {
      // No config, or a Postgres brain (no PGLite data dir → no IPC socket).
      // ENGINE-FREE means no direct-engine fallback here; pull-mode covers it.
      return { outcome: 'degraded', reason: 'no_pglite_path' };
    }
    const socketPath = resolveSocketPath(cfg.database_path);
    const secret = readIpcSecret(cfg.database_path);
    if (!secret) return { outcome: 'degraded', reason: 'no_serve' };

    const sessionId = typeof j.session_id === 'string' ? j.session_id : undefined;
    const sourceId = process.env.GBRAIN_SOURCE || undefined;
    const res = await requestTurnContext(socketPath, {
      secret,
      window: turns,
      ...(priorContextText ? { priorContextText } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sourceId ? { sourceId } : {}),
      // Feedback-loop attribution: the serve logs the delivered block's
      // volunteered pages/pointers under this channel. Bootstrap registers
      // hooks for Claude Code only today; a future codex registration passes
      // `--harness codex` on the hook command.
      channel: io.harness ?? 'claude-code',
    });
    if (res === IPC_UNAVAILABLE) {
      return { outcome: 'degraded', reason: 'ipc_unavailable', turns: turns.length };
    }
    if ('degraded' in res && res.degraded === 'stale_serve') {
      // [A9] Protocol echo missing → v1 serve answered; degrade LOUDLY.
      return { outcome: 'degraded', reason: 'stale_serve', turns: turns.length };
    }
    const resp = res as TurnContextResponse;
    if (!resp.ok) {
      return { outcome: 'degraded', reason: reasonCode(resp.error ?? 'server_error'), turns: turns.length };
    }
    const text = resp.block?.text ?? '';
    if (!text) return { outcome: 'ok', reason: 'empty_block', turns: turns.length };

    // [ENG-1] The 10000-char harness cap applies to the WHOLE stdout payload;
    // the block is budgeted ≤8KB server-side, but JSON escaping inflates, so
    // trim defensively rather than letting the harness divert-and-drop.
    let blockText = text;
    let payload = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: blockText },
    });
    while (payload.length > CLAUDE_HOOK_OUTPUT_CAP_CHARS && blockText.length > 0) {
      blockText = blockText.slice(0, Math.max(0, blockText.length - (payload.length - CLAUDE_HOOK_OUTPUT_CAP_CHARS) - 16));
      payload = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: blockText },
      });
    }
    if (blockText.length === 0) return { outcome: 'degraded', reason: 'over_cap', turns: turns.length };
    guardedWrite(payload + '\n');
    // Partial trim is delivery-count drift: the serve already logged the FULL
    // post-budget set at the response write, but pages cut from the tail here
    // were never injected. Record it so the doctor's heartbeat reconciliation
    // (and a future reconciler) can see the divergence — outcome stays ok
    // (context WAS injected), the reason carries the signal.
    if (blockText.length < text.length) {
      return { outcome: 'ok', reason: 'trimmed', turns: turns.length };
    }
    return { outcome: 'ok', turns: turns.length };
  })();

  let result: UserPromptOutcome;
  try {
    const raced = await withDeadline(io.userPromptDeadlineMs ?? USER_PROMPT_DEADLINE_MS, work);
    if (raced === DEADLINE) {
      expired = true; // late writes are suppressed — a post-deadline block must not appear
      result = { outcome: 'degraded', reason: 'deadline' };
    } else {
      result = raced;
    }
  } catch (e) {
    expired = true;
    result = { outcome: 'error', reason: errorCode(e) };
  }
  await writeHeartbeat({
    ts: new Date().toISOString(),
    event: 'user-prompt',
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    duration_ms: Date.now() - t0,
    ...(result.turns !== undefined ? { turns: result.turns } : {}),
  });
  return 0;
}

// ── stop [G15] ──────────────────────────────────────────────────────────────

async function hookStop(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  try {
    const j = await readStdinJson(io, 300);
    const sessionId = sanitizeSessionId(j?.session_id);
    const dir = await liveBufferDir();
    const exchange = firstString(j, ['last_assistant_message', 'lastAssistantMessage', 'prompt']);
    const entry = {
      ts: new Date().toISOString(),
      session_id: sessionId,
      ...(exchange ? { exchange: exchange.slice(0, 400) } : {}),
    };
    appendFileSync(join(dir, `${sessionId}.txt`), JSON.stringify(entry) + '\n', { mode: 0o600 });
    gcOldFiles(dir, STOP_BUFFER_RETENTION_MS);
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e);
  }
  await writeHeartbeat({
    ts: new Date().toISOString(),
    event: 'stop',
    outcome,
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
  });
  return 0;
}

function firstString(j: Record<string, unknown> | null, keys: string[]): string | null {
  if (!j) return null;
  for (const k of keys) {
    const v = j[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function gcOldFiles(dir: string, maxAgeMs: number): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch {
        /* per-file best effort */
      }
    }
  } catch {
    /* GC never breaks the hook */
  }
}

// ── session-end [S3#2, G3, G15] ─────────────────────────────────────────────

async function corpusDir(cfg: GBrainConfig | null): Promise<string> {
  const configured = cfg?.dream?.synthesize?.session_corpus_dir;
  if (configured && isAbsolute(configured)) return ensureDir0700(configured);
  const home = await resolveHome();
  ensureDir0700(join(home, 'transcripts'));
  return ensureDir0700(join(home, 'transcripts', 'corpus'));
}

function corpusRetentionDays(cfg: GBrainConfig | null): number {
  // Key is plan-defined [G15] but not yet in the GBrainConfig type (config.ts
  // is another lane's file) — read tolerantly.
  const synth = cfg?.dream?.synthesize as Record<string, unknown> | undefined;
  const v = synth?.corpus_retention_days;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : CORPUS_RETENTION_DAYS_DEFAULT;
}

async function hookSessionEnd(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  let turnsN: number | undefined;
  let bytesN: number | undefined;
  let redactionsN: number | undefined;
  const degrade = (r: string) => {
    if (outcome === 'ok') {
      outcome = 'degraded';
      reason = r;
    }
  };

  let sessionId = 'unknown';
  let ws: string | undefined;
  try {
    const j = await readStdinJson(io, 500);
    sessionId = sanitizeSessionId(j?.session_id);
    ws = io.cwd ?? (typeof j?.cwd === 'string' ? (j.cwd as string) : process.cwd());
    const cfg = loadConfig();

    const conf = confineTranscriptPath(j?.transcript_path, {
      ...(io.transcriptRoot ? { root: io.transcriptRoot } : {}),
    });
    if (!conf.ok) {
      degrade(`transcript_${conf.reason}`);
    } else {
      const parsed = parseTranscript(conf.path);
      turnsN = parsed.turns.length;
      bytesN = parsed.bytesRead;
      if (bytesN > 0 && turnsN === 0) {
        // [G3] LOUD: the host format drifted under us — heartbeat error +
        // status file surfaced at the next session-start.
        outcome = 'error';
        reason = 'parser_drift';
        try {
          const p = await hookStatusPath();
          writeFileSync(
            p,
            JSON.stringify({ ts: new Date().toISOString(), error: 'parser_drift', bytes: bytesN }, null, 2) + '\n',
            { mode: 0o600 },
          );
        } catch {
          /* status telemetry best-effort */
        }
      } else if (turnsN > 0) {
        // [S3#2] Secret-scan AT WRITE TIME. Scanner absent → still write
        // (the corpus is 0700-local), but say so in the heartbeat.
        let text = toCorpusText(parsed.turns);
        try {
          const scan = await import('../core/secret-scan.ts');
          const redacted = scan.redactFindings(text);
          text = redacted.text;
          // COUNT only — the findings themselves never land in telemetry [S3#7].
          redactionsN = redacted.redactions.length;
        } catch {
          degrade('scan_unavailable');
        }
        const dir = await corpusDir(cfg);
        // Session-id-keyed filename: a resumed session OVERWRITES its own
        // corpus file — dedup by construction [A6]. The write is ATOMIC
        // (tmp+rename) so a concurrent sweep never reads a torn half-write,
        // and the stale `.ingested`/`.in-progress` sidecars are dropped AFTER
        // the rename so the sweep re-processes the appended transcript (a
        // resumed session's new turns were being permanently skipped when the
        // completion sidecar survived the overwrite).
        const corpusFile = join(dir, `${sessionId}.txt`);
        const tmpCorpus = `${corpusFile}.tmp-${process.pid}`;
        writeFileSync(tmpCorpus, text, { mode: 0o600 });
        renameSync(tmpCorpus, corpusFile);
        try {
          rmSync(corpusFile + CORPUS_INGESTED_SUFFIX, { force: true });
        } catch {
          /* best effort — sidecar invalidation never fails the hook */
        }
        try {
          rmSync(corpusFile + CORPUS_CLAIM_SUFFIX, { force: true });
        } catch {
          /* best effort */
        }
        gcOldFiles(dir, corpusRetentionDays(cfg) * 24 * 60 * 60 * 1000); // [G15]
      }
    }
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e);
  }

  // Best-effort workspace push (the no-daemon persistence backstop, plan D6)
  // — same initialized-manifest gate as session-start [G4]. Spawned DETACHED,
  // never inline: the hook must exit far inside the harness's 60s cap
  // regardless of repo/network state. Fires on clean trees too (a prior
  // failure may have left local ahead; workspacePush handles that + its own
  // in-flight lock in the child).
  try {
    if (ws) {
      const root = await resolveBootstrapWorkspaceRoot(ws);
      if (root && (await repoPhaseComplete(root))) {
        try {
          (io.spawnPush ?? spawnDetachedPush)(root);
          if (outcome === 'ok' && !reason) reason = 'push_spawned';
        } catch {
          degrade('push_unavailable');
        }
      } else if (root && outcome === 'ok' && !reason) {
        // Repo phase not finished (create-repo-first, before `bootstrap repo`):
        // defer the push so we never publish to an unverified-privacy origin.
        reason = 'push_deferred_repo_pending';
      }
    }
  } catch {
    /* best effort */
  }

  // GC this session's stop buffer [G15].
  try {
    const dir = await liveBufferDir();
    rmSync(join(dir, `${sessionId}.txt`), { force: true });
  } catch {
    /* best effort */
  }

  await writeHeartbeat({
    ts: new Date().toISOString(),
    event: 'session-end',
    outcome,
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
    ...(turnsN !== undefined ? { turns: turnsN } : {}),
    ...(bytesN !== undefined ? { bytes: bytesN } : {}),
    ...(redactionsN !== undefined ? { redactions: redactionsN } : {}),
  });
  return 0;
}

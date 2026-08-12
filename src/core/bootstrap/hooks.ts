/**
 * bootstrap/hooks.ts — Claude Code hook-settings writers + MCP registration
 * argv builders (agent-bootstrap plan: G5, G1, CX2-17, CX-P1.4, ENG-7).
 *
 * settings.local.json has NO comment-marker boundary (it's JSON), so the
 * managed-block idiom from frontmatter-install-hook.ts does not apply
 * [CX2-17]. Instead this is a STRUCTURAL JSON merger: gbrain-owned hook
 * entries are keyed by a `_gbrain` marker property on the command object
 * (host-specs.ts owns the marker + every other format assumption), removal
 * and dedupe match on the marker (surviving reordering and command-string
 * drift), and foreign hooks / permissions / every other settings key are
 * never touched. Writes are atomic (tmp + rename) with a `.bak` of the
 * previous file; a parse-broken existing file is backed up aside and the
 * write starts clean with a loud note in the result [G5].
 *
 * MCP registration helpers BUILD ARGV ONLY — the bootstrap dispatcher execs
 * them (and records the registration in the install receipt). Precedent:
 * connect.ts `buildClaudeMcpAddArgv`/`buildCodexMcpAddArgv` [ENG-7] — those
 * build the REMOTE-HTTP shape (`-t http <url>` + bearer token) and cannot
 * express a local stdio serve with env bindings, so the local shape lives
 * here rather than wrapping them. Env is explicit on the registration
 * [CX-P1.4]: GUI-spawned serves inherit no shell env, so GBRAIN_SOURCE [G1]
 * (and GBRAIN_HOME when isolated) ride the registration itself.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_SUBCOMMAND,
  CLAUDE_SETTINGS_FILE_RELPATH,
  GBRAIN_HOOK_MARKER_KEY,
  GBRAIN_HOOK_MARKER_VALUE,
  type ClaudeHookEvent,
} from './host-specs.ts';

// ── Types ───────────────────────────────────────────────────────────────────

/** Env vars embedded in each hook command string [G1, CX-P1.4]. */
export interface ClaudeHookEnv {
  /** Workspace source binding — required so hook context is source-scoped [G1]. */
  GBRAIN_SOURCE: string;
  /** Set only for --isolated installs (PARENT dir; config appends `.gbrain`). */
  GBRAIN_HOME?: string;
}

export interface WriteClaudeHooksOpts {
  /** Absolute path to the gbrain binary (GUI hosts inherit no PATH) [CX-P1.4]. */
  gbrainBin: string;
  env: ClaudeHookEnv;
  /** Per-event timeout override (SECONDS — the settings-file unit). */
  timeoutSecs?: Partial<Record<ClaudeHookEvent, number>>;
  /** Subset of events to wire; default all four. */
  events?: ClaudeHookEvent[];
}

export interface WriteClaudeHooksResult {
  settingsPath: string;
  installed: Array<{ event: ClaudeHookEvent; command: string }>;
  /** Prior marker-carrying entries replaced (idempotent re-run dedupe). */
  removedPrior: number;
  /** `.bak` of the pre-write file (null when no file existed). */
  backupPath: string | null;
  /** Where a parse-broken original was moved (null when parse succeeded). */
  brokenBackupPath: string | null;
  notes: string[];
}

export interface RemoveClaudeHooksResult {
  settingsPath: string;
  removed: number;
  backupPath: string | null;
  notes: string[];
}

/** One command object inside a hook matcher group (host-specs shape). */
interface HookCommandEntry {
  type: 'command';
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks?: unknown[];
  [key: string]: unknown;
}

type SettingsObject = Record<string, unknown>;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function claudeSettingsPath(workspaceDir: string): string {
  return join(workspaceDir, CLAUDE_SETTINGS_FILE_RELPATH);
}

/**
 * POSIX single-quote anything not already shell-safe (mirror of connect.ts's
 * private shellQuote — same contract: `$()`/backticks in a value are inert
 * literals). `=` is in the safe set so plain `K=V` env assignments stay bare.
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Render the hook command string: `env K=V… <bin> hook <subcommand>`. */
export function buildClaudeHookCommand(
  gbrainBin: string,
  event: ClaudeHookEvent,
  env: ClaudeHookEnv,
): string {
  const assignments: string[] = [`GBRAIN_SOURCE=${env.GBRAIN_SOURCE}`];
  if (env.GBRAIN_HOME) assignments.push(`GBRAIN_HOME=${env.GBRAIN_HOME}`);
  const parts = ['env', ...assignments, gbrainBin, 'hook', CLAUDE_HOOK_SUBCOMMAND[event]];
  return parts.map(shellQuote).join(' ');
}

function isOurs(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as Record<string, unknown>)[GBRAIN_HOOK_MARKER_KEY] === GBRAIN_HOOK_MARKER_VALUE
  );
}

/**
 * Strip marker-carrying command entries from one event's matcher-group array.
 * Groups EMPTIED by the removal are dropped; groups that were already empty
 * (foreign) survive untouched. Returns the surviving groups + removal count.
 */
function stripOurEntries(groups: unknown[]): { kept: unknown[]; removed: number } {
  const kept: unknown[] = [];
  let removed = 0;
  for (const group of groups) {
    if (typeof group !== 'object' || group === null || !Array.isArray((group as HookMatcherGroup).hooks)) {
      kept.push(group); // structurally foreign — never touch
      continue;
    }
    const g = group as HookMatcherGroup;
    const before = g.hooks!.length;
    const filtered = g.hooks!.filter((h) => !isOurs(h));
    removed += before - filtered.length;
    if (filtered.length === 0 && before > 0 && filtered.length !== before) {
      continue; // we emptied it → drop the husk
    }
    if (filtered.length !== before) {
      kept.push({ ...g, hooks: filtered });
    } else {
      kept.push(group);
    }
  }
  return { kept, removed };
}

/** Atomic write (tmp + rename), creating parent dirs. */
function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

interface LoadedSettings {
  settings: SettingsObject;
  existed: boolean;
  brokenBackupPath: string | null;
  notes: string[];
}

/**
 * Parse the existing settings file. Absent/empty → `{}`. Parse error → the
 * broken file is MOVED to a timestamped `.broken-*` backup and the caller
 * starts clean, with a loud note (the user's broken-by-hand file is never
 * silently destroyed, and never silently half-merged) [G5].
 */
function loadSettings(path: string): LoadedSettings {
  const notes: string[] = [];
  if (!existsSync(path)) {
    return { settings: {}, existed: false, brokenBackupPath: null, notes };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  if (raw.trim() === '') {
    return { settings: {}, existed: true, brokenBackupPath: null, notes };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings root is not a JSON object');
    }
    return { settings: parsed as SettingsObject, existed: true, brokenBackupPath: null, notes };
  } catch (e) {
    const broken = `${path}.broken-${Date.now()}`;
    copyFileSync(path, broken);
    notes.push(
      `WARNING: ${path} was not valid JSON (${(e as Error).message}); ` +
        `the original was backed up to ${broken} and hooks were written to a fresh file. ` +
        `Restore any hand-made settings from the backup.`,
    );
    return { settings: {}, existed: true, brokenBackupPath: broken, notes };
  }
}

// ── Writers [G5, CX2-17] ────────────────────────────────────────────────────

/**
 * Structural-merge gbrain's hook entries into `<ws>/.claude/settings.local.json`.
 * Idempotent: prior marker-carrying entries are removed before the fresh set
 * is appended (run twice → one entry per event). Foreign hooks, permissions,
 * and every other key survive byte-for-byte at the structural level.
 */
export function writeClaudeHooks(
  workspaceDir: string,
  opts: WriteClaudeHooksOpts,
): WriteClaudeHooksResult {
  if (!isAbsolute(opts.gbrainBin)) {
    throw new Error(`gbrainBin must be an absolute path (GUI hosts inherit no PATH); got: ${opts.gbrainBin}`);
  }
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === 'string' && /[\n\r\0]/.test(v)) {
      throw new Error(`env ${k} contains control characters — refusing to embed in a hook command`);
    }
  }

  const settingsPath = claudeSettingsPath(workspaceDir);
  const { settings, existed, brokenBackupPath, notes } = loadSettings(settingsPath);

  // hooks key: merge into an object; a structurally-foreign value is backed
  // up via the .bak below and replaced (we cannot merge into a non-object).
  let hooks = settings.hooks as Record<string, unknown> | undefined;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    if (hooks !== undefined) {
      notes.push(
        `WARNING: existing "hooks" key was not an object (${JSON.stringify(hooks).slice(0, 80)}); ` +
          `replaced — the original file is in the .bak backup.`,
      );
    }
    hooks = {};
  }

  const events = opts.events ?? [...CLAUDE_HOOK_EVENTS];
  let removedPrior = 0;
  const installed: Array<{ event: ClaudeHookEvent; command: string }> = [];

  for (const event of events) {
    let groups = hooks[event];
    if (!Array.isArray(groups)) {
      if (groups !== undefined) {
        notes.push(
          `WARNING: existing hooks.${event} was not an array; replaced — original in the .bak backup.`,
        );
      }
      groups = [];
    }
    const { kept, removed } = stripOurEntries(groups as unknown[]);
    removedPrior += removed;

    const command = buildClaudeHookCommand(opts.gbrainBin, event, opts.env);
    const timeout = opts.timeoutSecs?.[event] ?? CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS[event];
    const entry: HookCommandEntry = {
      type: 'command',
      command,
      timeout,
      [GBRAIN_HOOK_MARKER_KEY]: GBRAIN_HOOK_MARKER_VALUE,
    };
    kept.push({ hooks: [entry] });
    hooks[event] = kept;
    installed.push({ event, command });
  }

  settings.hooks = hooks;

  let backupPath: string | null = null;
  if (existed && brokenBackupPath === null) {
    backupPath = `${settingsPath}.bak`;
    copyFileSync(settingsPath, backupPath);
  }
  atomicWriteJson(settingsPath, settings);

  return { settingsPath, installed, removedPrior, backupPath, brokenBackupPath, notes };
}

/**
 * Remove ONLY marker-carrying entries [G5]. A parse-broken file is left
 * untouched (removal must never destroy what it cannot read) — the note says
 * so. Event arrays we emptied lose their key; an emptied hooks object loses
 * its key; foreign structure survives.
 */
export function removeClaudeHooks(workspaceDir: string): RemoveClaudeHooksResult {
  const settingsPath = claudeSettingsPath(workspaceDir);
  const notes: string[] = [];
  if (!existsSync(settingsPath)) {
    return { settingsPath, removed: 0, backupPath: null, notes: ['no settings file — nothing to remove'] };
  }
  let settings: SettingsObject;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    if (raw.trim() === '') {
      return { settingsPath, removed: 0, backupPath: null, notes: ['settings file empty — nothing to remove'] };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings root is not a JSON object');
    }
    settings = parsed as SettingsObject;
  } catch (e) {
    return {
      settingsPath,
      removed: 0,
      backupPath: null,
      notes: [
        `WARNING: ${settingsPath} is not valid JSON (${(e as Error).message}); ` +
          `left untouched — remove gbrain hook entries by hand or fix the JSON and re-run.`,
      ],
    };
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return { settingsPath, removed: 0, backupPath: null, notes: ['no hooks object — nothing to remove'] };
  }

  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue; // structurally foreign — never touch
    const { kept, removed: n } = stripOurEntries(groups);
    removed += n;
    if (n === 0) continue;
    if (kept.length === 0) {
      delete hooks[event]; // emptied by OUR removal — drop the key
    } else {
      hooks[event] = kept;
    }
  }
  if (removed > 0 && Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  let backupPath: string | null = null;
  if (removed > 0) {
    backupPath = `${settingsPath}.bak`;
    copyFileSync(settingsPath, backupPath);
    atomicWriteJson(settingsPath, settings);
  }
  return { settingsPath, removed, backupPath, notes };
}

// ── MCP registration argv builders [G1, CX-P1.4, ENG-7] ────────────────────

export interface ClaudeMcpRegistration {
  /** MCP server name; default 'gbrain'. */
  name?: string;
  /** Absolute path to the gbrain binary. */
  gbrainBin: string;
  /** Registration scope — a consent question, never a default the user didn't pick [G16/D1]. */
  scope: 'project' | 'user';
  /** Workspace source slug [G1] — agent writes must land in the workspace source. */
  sourceId: string;
  /** PARENT dir for --isolated installs (config appends `.gbrain`) [CX2-8]. */
  gbrainHome?: string;
}

export type CodexMcpRegistration = Omit<ClaudeMcpRegistration, 'scope'>;

/**
 * `claude mcp add` argv for a LOCAL stdio serve. Returns command argv arrays
 * (binary first) — the dispatcher execs them; nothing here touches the
 * filesystem or the network. Shape per TARGETS['claude-code-2026-08'].
 *
 * The serve argv pins `--surface full`: bootstrap's contract (put_page,
 * get_page, timeline, …) needs the full op surface, and a pre-existing
 * `mcp_surface: verbs` config row must not silently narrow the registration.
 */
export function registerClaudeMcp(p: ClaudeMcpRegistration): string[][] {
  if (!isAbsolute(p.gbrainBin)) {
    throw new Error(`gbrainBin must be an absolute path; got: ${p.gbrainBin}`);
  }
  const name = p.name ?? 'gbrain';
  const argv = [
    'claude', 'mcp', 'add', name,
    '--scope', p.scope,
    '-e', `GBRAIN_SOURCE=${p.sourceId}`,
  ];
  if (p.gbrainHome) argv.push('-e', `GBRAIN_HOME=${p.gbrainHome}`);
  argv.push('--', p.gbrainBin, 'serve', '--surface', 'full');
  return [argv];
}

/**
 * `codex mcp add` argv for a LOCAL stdio serve (writes ~/.codex/config.toml
 * itself — no TOML writer needed in v1, see TARGETS['codex-2026-08']).
 * Codex registrations are user-global; there is no scope flag.
 * `--surface full` pins the full op surface (see registerClaudeMcp).
 */
export function registerCodexMcp(p: CodexMcpRegistration): string[][] {
  if (!isAbsolute(p.gbrainBin)) {
    throw new Error(`gbrainBin must be an absolute path; got: ${p.gbrainBin}`);
  }
  const name = p.name ?? 'gbrain';
  const argv = ['codex', 'mcp', 'add', name, '--env', `GBRAIN_SOURCE=${p.sourceId}`];
  if (p.gbrainHome) argv.push('--env', `GBRAIN_HOME=${p.gbrainHome}`);
  argv.push('--', p.gbrainBin, 'serve', '--surface', 'full');
  return [argv];
}

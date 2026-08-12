/**
 * bootstrap/hooks.ts writers + host-specs (agent-bootstrap G5, CX2-17, G1,
 * CX-P1.4, ENG-7): structural JSON merge preserves foreign hooks/permissions,
 * marker dedupe makes re-runs idempotent, broken-JSON originals are backed up
 * (never silently destroyed), removal strips ONLY marker-carrying entries,
 * and the MCP registration helpers build argv only.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildClaudeHookCommand,
  claudeSettingsPath,
  registerClaudeMcp,
  registerCodexMcp,
  removeClaudeHooks,
  writeClaudeHooks,
} from '../src/core/bootstrap/hooks.ts';
import {
  CLAUDE_CODE_SPEC_ID,
  CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS,
  CLAUDE_HOOK_EVENTS,
  CODEX_SPEC_ID,
  GBRAIN_HOOK_MARKER_KEY,
  GBRAIN_HOOK_MARKER_VALUE,
  TARGETS,
} from '../src/core/bootstrap/host-specs.ts';

const BIN = '/opt/gbrain/bin/gbrain';
const ENV = { GBRAIN_SOURCE: 'workspace' };

let tmp: string | null = null;
function ws(): string {
  tmp = mkdtempSync(join(tmpdir(), 'gb-hooks-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function readSettings(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeSettingsPath(dir), 'utf8'));
}

type Group = { matcher?: string; hooks: Array<Record<string, unknown>> };

function markerEntries(settings: Record<string, unknown>, event: string): Array<Record<string, unknown>> {
  const groups = ((settings.hooks as Record<string, unknown>)?.[event] ?? []) as Group[];
  return groups.flatMap((g) => (g.hooks ?? []).filter((h) => h[GBRAIN_HOOK_MARKER_KEY] === GBRAIN_HOOK_MARKER_VALUE));
}

describe('host-specs [ENG-7]', () => {
  test('both targets carry the dated spec-target shape', () => {
    for (const id of [CLAUDE_CODE_SPEC_ID, CODEX_SPEC_ID]) {
      const t = TARGETS[id];
      expect(t).toBeDefined();
      expect(t.id).toBe(id);
      expect(['verified', 'provisional']).toContain(t.status);
      expect(t.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.references.length).toBeGreaterThan(0);
      expect(t.note.length).toBeGreaterThan(40);
    }
    expect(TARGETS[CLAUDE_CODE_SPEC_ID].status).toBe('verified');
    expect(TARGETS[CLAUDE_CODE_SPEC_ID].references.join(' ')).toContain('code.claude.com');
    // Codex mcp-add shape is docs-derived, not live-host-verified.
    expect(TARGETS[CODEX_SPEC_ID].status).toBe('provisional');
    // The v1 "no TOML writer" decision is recorded where the format lives.
    expect(TARGETS[CODEX_SPEC_ID].note).toContain('TOML');
  });
});

describe('writeClaudeHooks [G5, CX2-17]', () => {
  test('fresh workspace: all four events wired with marker + env + timeout', () => {
    const dir = ws();
    const res = writeClaudeHooks(dir, { gbrainBin: BIN, env: ENV });
    expect(res.settingsPath).toBe(claudeSettingsPath(dir));
    expect(res.installed.map((i) => i.event).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    expect(res.backupPath).toBeNull();
    expect(res.brokenBackupPath).toBeNull();

    const settings = readSettings(dir);
    for (const event of CLAUDE_HOOK_EVENTS) {
      const ours = markerEntries(settings, event);
      expect(ours).toHaveLength(1);
      expect(ours[0].type).toBe('command');
      expect(ours[0].command).toContain(BIN);
      expect(ours[0].command).toContain('GBRAIN_SOURCE=workspace');
      expect(ours[0].timeout).toBe(CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS[event]);
    }
    // Event → subcommand mapping.
    expect(markerEntries(settings, 'UserPromptSubmit')[0].command).toContain('hook user-prompt');
    expect(markerEntries(settings, 'SessionStart')[0].command).toContain('hook session-start');
    expect(markerEntries(settings, 'Stop')[0].command).toContain('hook stop');
    expect(markerEntries(settings, 'SessionEnd')[0].command).toContain('hook session-end');
  });

  test('timeoutSecs override + GBRAIN_HOME env embedding', () => {
    const dir = ws();
    writeClaudeHooks(dir, {
      gbrainBin: BIN,
      env: { GBRAIN_SOURCE: 'src-a', GBRAIN_HOME: '/tmp/iso home' },
      timeoutSecs: { SessionEnd: 120 },
    });
    const settings = readSettings(dir);
    const cmd = markerEntries(settings, 'SessionEnd')[0];
    expect(cmd.timeout).toBe(120);
    // Space-carrying value gets shell-quoted, not broken.
    expect(cmd.command).toContain("'GBRAIN_HOME=/tmp/iso home'");
    expect(markerEntries(settings, 'Stop')[0].timeout).toBe(CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS.Stop);
  });

  test('foreign hooks + permissions survive; ours appended', () => {
    const dir = ws();
    const foreign = {
      permissions: { allow: ['Bash(npm run *)'] },
      otherTopLevel: { keep: true },
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'my-custom-hook.sh', timeout: 9 }] },
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] },
        ],
      },
    };
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(claudeSettingsPath(dir), JSON.stringify(foreign, null, 2));

    writeClaudeHooks(dir, { gbrainBin: BIN, env: ENV });
    const settings = readSettings(dir);
    expect(settings.permissions).toEqual(foreign.permissions);
    expect(settings.otherTopLevel).toEqual(foreign.otherTopLevel);
    const hooks = settings.hooks as Record<string, Group[]>;
    // Foreign PreToolUse untouched.
    expect(hooks.PreToolUse).toEqual(foreign.hooks.PreToolUse as Group[]);
    // Foreign UserPromptSubmit entry intact, ours appended after it.
    const upGroups = hooks.UserPromptSubmit;
    expect(upGroups[0].hooks[0].command).toBe('my-custom-hook.sh');
    expect(markerEntries(settings, 'UserPromptSubmit')).toHaveLength(1);
  });

  test('marker dedupe: running twice leaves exactly one entry per event', () => {
    const dir = ws();
    writeClaudeHooks(dir, { gbrainBin: BIN, env: ENV });
    const second = writeClaudeHooks(dir, { gbrainBin: '/new/path/gbrain', env: { GBRAIN_SOURCE: 'renamed' } });
    expect(second.removedPrior).toBe(CLAUDE_HOOK_EVENTS.length);
    const settings = readSettings(dir);
    for (const event of CLAUDE_HOOK_EVENTS) {
      const ours = markerEntries(settings, event);
      expect(ours).toHaveLength(1);
      // Dedupe keys on the MARKER, so the refreshed command wins.
      expect(ours[0].command).toContain('/new/path/gbrain');
      expect(ours[0].command).toContain('GBRAIN_SOURCE=renamed');
    }
  });

  test('.bak backup written on overwrite of an existing file', () => {
    const dir = ws();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(claudeSettingsPath(dir), JSON.stringify({ permissions: { allow: ['X'] } }));
    const res = writeClaudeHooks(dir, { gbrainBin: BIN, env: ENV });
    expect(res.backupPath).toBe(`${claudeSettingsPath(dir)}.bak`);
    const bak = JSON.parse(readFileSync(res.backupPath!, 'utf8'));
    expect(bak).toEqual({ permissions: { allow: ['X'] } });
  });

  test('broken JSON: original backed up aside, loud note, clean file written', () => {
    const dir = ws();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(claudeSettingsPath(dir), '{ definitely broken json !!!');
    const res = writeClaudeHooks(dir, { gbrainBin: BIN, env: ENV });
    expect(res.brokenBackupPath).not.toBeNull();
    expect(existsSync(res.brokenBackupPath!)).toBe(true);
    expect(readFileSync(res.brokenBackupPath!, 'utf8')).toContain('definitely broken');
    expect(res.notes.join(' ')).toContain('not valid JSON');
    // Fresh file is valid and carries our hooks.
    const settings = readSettings(dir);
    expect(markerEntries(settings, 'SessionStart')).toHaveLength(1);
  });

  test('relative gbrainBin refused (GUI hosts inherit no PATH)', () => {
    const dir = ws();
    expect(() => writeClaudeHooks(dir, { gbrainBin: 'gbrain', env: ENV })).toThrow(/absolute/);
  });

  test('control chars in env values refused', () => {
    const dir = ws();
    expect(() =>
      writeClaudeHooks(dir, { gbrainBin: BIN, env: { GBRAIN_SOURCE: 'a\nb' } }),
    ).toThrow(/control characters/);
  });
});

describe('removeClaudeHooks [G5]', () => {
  test('removes only marker entries; foreign hooks + permissions intact', () => {
    const dir = ws();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      claudeSettingsPath(dir),
      JSON.stringify({
        permissions: { allow: ['Bash(ls *)'] },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'foreign.sh' }] }],
        },
      }),
    );
    writeClaudeHooks(dir, { gbrainBin: BIN, env: ENV });
    const res = removeClaudeHooks(dir);
    expect(res.removed).toBe(CLAUDE_HOOK_EVENTS.length);

    const settings = readSettings(dir);
    expect(settings.permissions).toEqual({ allow: ['Bash(ls *)'] });
    const hooks = settings.hooks as Record<string, Group[]>;
    // Foreign entry survives; our groups (and event keys we emptied) are gone.
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe('foreign.sh');
    expect(markerEntries(settings, 'UserPromptSubmit')).toHaveLength(0);
    expect(hooks.SessionStart).toBeUndefined();
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.SessionEnd).toBeUndefined();
  });

  test('remove on a purely-ours file drops the hooks key entirely', () => {
    const dir = ws();
    writeClaudeHooks(dir, { gbrainBin: BIN, env: ENV });
    removeClaudeHooks(dir);
    const settings = readSettings(dir);
    expect(settings.hooks).toBeUndefined();
  });

  test('absent file: no-op, nothing created', () => {
    const dir = ws();
    const res = removeClaudeHooks(dir);
    expect(res.removed).toBe(0);
    expect(existsSync(claudeSettingsPath(dir))).toBe(false);
  });

  test('broken JSON: left untouched with a note (removal never destroys)', () => {
    const dir = ws();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(claudeSettingsPath(dir), '{ broken !!!');
    const res = removeClaudeHooks(dir);
    expect(res.removed).toBe(0);
    expect(readFileSync(claudeSettingsPath(dir), 'utf8')).toBe('{ broken !!!');
    expect(res.notes.join(' ')).toContain('left untouched');
  });
});

describe('MCP registration argv builders [G1, CX-P1.4]', () => {
  test('registerClaudeMcp: stdio shape with scope + source env; serve pinned to --surface full', () => {
    const cmds = registerClaudeMcp({ gbrainBin: BIN, scope: 'project', sourceId: 'workspace' });
    expect(cmds).toEqual([
      ['claude', 'mcp', 'add', 'gbrain', '--scope', 'project', '-e', 'GBRAIN_SOURCE=workspace', '--', BIN, 'serve', '--surface', 'full'],
    ]);
  });

  test('registerClaudeMcp: user scope + isolated GBRAIN_HOME', () => {
    const cmds = registerClaudeMcp({
      name: 'mybrain', gbrainBin: BIN, scope: 'user', sourceId: 's1', gbrainHome: '/ws',
    });
    expect(cmds[0]).toEqual([
      'claude', 'mcp', 'add', 'mybrain', '--scope', 'user',
      '-e', 'GBRAIN_SOURCE=s1', '-e', 'GBRAIN_HOME=/ws', '--', BIN, 'serve', '--surface', 'full',
    ]);
  });

  test('registerCodexMcp: --env shape, no scope flag; serve pinned to --surface full', () => {
    const cmds = registerCodexMcp({ gbrainBin: BIN, sourceId: 'workspace', gbrainHome: '/ws' });
    expect(cmds).toEqual([
      ['codex', 'mcp', 'add', 'gbrain', '--env', 'GBRAIN_SOURCE=workspace', '--env', 'GBRAIN_HOME=/ws', '--', BIN, 'serve', '--surface', 'full'],
    ]);
  });

  test('builders refuse relative binaries', () => {
    expect(() => registerClaudeMcp({ gbrainBin: 'gbrain', scope: 'project', sourceId: 's' })).toThrow(/absolute/);
    expect(() => registerCodexMcp({ gbrainBin: './gbrain', sourceId: 's' })).toThrow(/absolute/);
  });
});

describe('buildClaudeHookCommand', () => {
  test('quotes unsafe values; bare env assignment stays bare', () => {
    const cmd = buildClaudeHookCommand(BIN, 'UserPromptSubmit', {
      GBRAIN_SOURCE: 'plain-slug',
      GBRAIN_HOME: '/has space/dir',
    });
    expect(cmd).toBe(
      `env GBRAIN_SOURCE=plain-slug 'GBRAIN_HOME=/has space/dir' ${BIN} hook user-prompt`,
    );
  });
});

/**
 * Block-format conversation normalizer.
 *
 * Some chat exports — notably the Slack collector gbrain's own ingestion
 * uses — emit a HEADER + indented-body BLOCK per message instead of the
 * single-line `**Name** (time): body` shape the built-in patterns
 * (`builtins.ts`) recognize:
 *
 *     - **Theo** (Mon 11:18)
 *       Hey everyone — quick update on the renewal.
 *
 *       Second paragraph of the same message.
 *     - **Juan** (Mon 11:20)
 *       Reply body...
 *
 * None of the 14 line-oriented built-ins match this: a leading `- ` list
 * marker, a day-of-week + time with no trailing colon, and the message body on
 * the following indented lines. Result: `phase: 'no_match'`, zero messages,
 * and the whole comms corpus is silently un-extractable (facts stay empty →
 * `find_trajectory` returns nothing).
 *
 * This collapses each block into the canonical `**Name** (HH:MM): <body joined
 * to one line>` shape so the existing `bold-paren-time` pattern matches; the
 * per-message date fills in downstream via `fallbackDate` (the page date).
 *
 * STRICT no-op unless the block signature is present: the header regex requires
 * the paren-group to END the line (no inline `: body`), which is exactly what
 * the single-line patterns always produce — so feeding already-canonical
 * content through this function returns it unchanged.
 */

// `- **Name** (Mon 11:18)` / `- **Name** (11:18 AM)` / `- **Name** (16:36)`.
// Day-of-week optional; 12h/24h time; optional am/pm; the line ENDS at the
// close paren (no inline `: body` — that is what distinguishes a block header
// from the single-line `**Name** (time): body` patterns).
const BLOCK_HEADER =
  /^\s*-\s+\*\*(.+?)\*\*\s+\((?:[A-Za-z]{2,9}\.?\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?\)\s*$/;

// Nexus Slack archive: `**[2026-07-03T08:34:04-05:00] Name ↪** (ts=...)`.
const SLACK_ARCHIVE_HEADER =
  /^\s*\*\*\[(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})\]\s+(.+?)\*\*\s+\([^)]*\)\s*$/;

function parseHeader(line: string): { name: string; time: string; date?: string } | null {
  const block = BLOCK_HEADER.exec(line);
  if (block) {
    const hour = to24h(parseInt(block[2], 10), block[4]);
    return { name: block[1].trim(), time: `${String(hour).padStart(2, '0')}:${block[3]}` };
  }
  const archive = SLACK_ARCHIVE_HEADER.exec(line);
  if (!archive) return null;
  const utc = new Date(`${archive[1]}T${archive[2]}:${archive[3]}:00${archive[4]}`).toISOString();
  return {
    name: archive[5].replace(/\s+↪$/, '').trim(),
    date: utc.slice(0, 10),
    time: utc.slice(11, 16),
  };
}

/** True when at least one line is a block-format message header. */
export function looksLikeBlockConversation(body: string): boolean {
  for (const line of body.split('\n')) {
    if (parseHeader(line)) return true;
  }
  return false;
}

function to24h(hour: number, ampm?: string): number {
  if (!ampm) return hour;
  const lower = ampm.toLowerCase();
  if (lower === 'pm' && hour < 12) return hour + 12;
  if (lower === 'am' && hour === 12) return 0;
  return hour;
}

/**
 * Collapse block-format messages into canonical single-line `**Name** (HH:MM):
 * body` lines. Returns `body` unchanged when no block header is present.
 */
export function normalizeBlockConversation(body: string): string {
  if (!looksLikeBlockConversation(body)) return body;

  const lines = body.split('\n');
  const out: string[] = [];
  let current: { name: string; time: string; date?: string } | null = null;
  let bodyParts: string[] = [];

  const flush = () => {
    if (current) {
      const text = bodyParts.join(' ').replace(/\s+/g, ' ').trim();
      const timestamp = current.date ? `${current.date} ${current.time}` : current.time;
      out.push(`**${current.name}** (${timestamp}): ${text}`);
    }
    current = null;
    bodyParts = [];
  };

  for (const line of lines) {
    const header = parseHeader(line);
    if (header) {
      flush();
      current = header;
    } else if (current) {
      // Body line of the current message. Drop blank lines; keep the rest.
      const trimmed = line.trim();
      if (trimmed) bodyParts.push(trimmed);
    }
    // Lines before the first header (page title, leading blanks) are dropped —
    // they never matched a pattern anyway.
  }
  flush();

  return out.length > 0 ? out.join('\n') : body;
}

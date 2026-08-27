/**
 * conversation_format_coverage check — peeled verbatim from src/commands/doctor.ts
 * (3d.3 v0.41.13.0) so it is unit-testable against PGLite, following the
 * computeExtractAtomsBacklogCheck pattern. doctor.ts re-exports it under the
 * facade rule.
 *
 * Scans up to 200 most-recent conversation-type pages (50 per allowed type),
 * runs parseConversation in dry mode, reports per-pattern hit counts +
 * unmatched count. Warn at >10% unmatched with paste-ready hint pointing at
 * `gbrain conversation-parser scan <slug>`.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { ALLOWED_TYPES } from '../../../core/facts/conversation-types.ts';
import type { Check } from '../../doctor.ts';

export async function computeConversationFormatCoverageCheck(
  engine: BrainEngine,
): Promise<Check> {
  const name = 'conversation_format_coverage';
  try {
    const { readConversationBodyForParsing } = await import('../../../core/conversation-parser/body.ts');
    const { parseConversation } = await import('../../../core/conversation-parser/parse.ts');
    // Single source of truth for the conversation-facts type allowlist (#4135).
    const allowedTypes = ALLOWED_TYPES;
    // PageFilters supports singular `type` only; iterate the allowed types
    // and cap at ~50/each to land at ~200 total max.
    const sample: import('../../../core/types.ts').Page[] = [];
    for (const t of allowedTypes) {
      const slice = await engine.listPages({ limit: 50, type: t as import('../../../core/types.ts').PageType });
      sample.push(...slice);
    }
    if (sample.length === 0) {
      return {
        name,
        status: 'ok',
        message: 'No conversation-type pages — coverage check not applicable',
      };
    }
    const { isTranscriptClaiming } = await import('../../../core/conversation-parser/transcript-signals.ts');
    const hitsByPattern: Record<string, number> = {};
    let unmatched = 0;
    let summaryOnly = 0;
    let evaluated = 0;
    const llmFallbackEnabled =
      (await engine.getConfig('conversation_parser.llm_fallback_enabled')) === 'true';
    for (const page of sample) {
      const body = await readConversationBodyForParsing(engine, page);
      // Empty collector placeholders and operational skill docs are not
      // conversations, even when legacy schema inference labels them slack.
      if (!body.trim() || page.slug.startsWith('skills/')) continue;
      evaluated++;
      const result = parseConversation(body, { page, noPolish: true, noFallback: true });
      const usesMeetingFallback =
        result.phase === 'no_match' && page.type === 'meeting' && llmFallbackEnabled;
      // #4193: a no_match on a page that never claimed a transcript
      // (summary-only meeting/slack page) is not parser debt. Report it
      // separately and keep it out of the coverage denominator. Configured
      // meeting fallback and transcript-claiming misses retain their behavior.
      if (result.phase === 'no_match' && !usesMeetingFallback && !isTranscriptClaiming(page, body)) {
        hitsByPattern['_summary_only'] = (hitsByPattern['_summary_only'] ?? 0) + 1;
        summaryOnly++;
        continue;
      }
      const id = usesMeetingFallback
        ? '_llm_fallback'
        : (result.matched_pattern_id ?? '_no_match');
      hitsByPattern[id] = (hitsByPattern[id] ?? 0) + 1;
      if (result.phase === 'no_match' && !usesMeetingFallback) unmatched++;
    }
    const candidates = evaluated - summaryOnly;
    const unmatchedPct = candidates > 0 ? (unmatched / candidates) * 100 : 0;
    const breakdown = Object.entries(hitsByPattern)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    if (unmatchedPct > 10) {
      return {
        name,
        status: 'warn',
        message:
          `${unmatched}/${candidates} transcript-bearing conversation pages (${unmatchedPct.toFixed(1)}%) match NO built-in pattern. ` +
          `Breakdown: ${breakdown}. ` +
          `Investigate: gbrain conversation-parser scan <slug>`,
      };
    }
    return {
      name,
      status: 'ok',
      message: `${evaluated} non-empty pages: ${breakdown}`,
    };
  } catch (err) {
    return {
      name,
      status: 'warn',
      message: `Could not check conversation format coverage: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}

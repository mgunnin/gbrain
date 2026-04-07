import type { GBrainStore } from "../indexer/store.js";

export interface ConfidenceParams {
  entity: string;
}

export interface ClaimConfidence {
  claim: string;
  confidence: "high" | "medium" | "low";
  sources: string[];
  lastVerified: string | null;
  note: string;
}

export interface ConfidenceResult {
  entity: string;
  path: string | null;
  claims: ClaimConfidence[];
  queryTimeMs: number;
}

/** Patterns that signal a sentence contains a concrete factual claim. */
const FACTUAL_PATTERNS: RegExp[] = [
  /\$[\d,.]+\s*(M|B|K|million|billion|thousand)?/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d+\s*(employees|people|users|customers)\b/i,
  /\b(Series [A-Z]|seed round|pre-seed)\b/i,
  /\b(raised|founded|acquired|valued|funded|launched)\b.*\b\d/i,
];

function isFactualClaim(sentence: string): boolean {
  return FACTUAL_PATTERNS.some((p) => p.test(sentence));
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
}

/**
 * Extract key numeric/date terms from a claim to look for in the timeline.
 */
function extractKeyTerms(claim: string): string[] {
  const terms: string[] = [];

  const numMatches = claim.match(/\$?[\d,.]+\s*(M|B|K|million|billion|%)?/gi);
  if (numMatches) terms.push(...numMatches.map((t) => t.trim()).filter((t) => t.length > 1));

  const dateMatches = claim.match(/\b\d{4}(?:-\d{2}-\d{2})?\b/g);
  if (dateMatches) terms.push(...dateMatches);

  return terms;
}

/**
 * Count how many timeline lines corroborate the claim by sharing key terms.
 */
function countCorroborations(claim: string, timelineText: string): number {
  if (!timelineText) return 0;

  const keyTerms = extractKeyTerms(claim);
  if (keyTerms.length === 0) return 0;

  const threshold = Math.ceil(keyTerms.length / 2);
  let count = 0;

  for (const line of timelineText.split("\n")) {
    const lineUpper = line.toUpperCase();
    const matches = keyTerms.filter((t) => lineUpper.includes(t.toUpperCase()));
    if (matches.length >= threshold) count++;
  }

  return count;
}

/** Find the most recent ISO date in the timeline text. */
function mostRecentDate(timelineText: string): string | null {
  const dates = timelineText.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (!dates || dates.length === 0) return null;
  return dates.slice().sort().reverse()[0] ?? null;
}

function scoreConfidence(
  corroborations: number,
  lastVerified: string | null
): { confidence: "high" | "medium" | "low"; note: string } {
  const ageMonths = lastVerified
    ? (Date.now() - new Date(lastVerified).getTime()) / (1000 * 60 * 60 * 24 * 30)
    : Infinity;

  if (corroborations >= 3 && ageMonths < 6) {
    return {
      confidence: "high",
      note: `${corroborations} sources, verified ${Math.round(ageMonths)}mo ago`,
    };
  }
  if (corroborations >= 1 && ageMonths < 12) {
    return {
      confidence: "medium",
      note: `${corroborations} source(s), verified ${Math.round(ageMonths)}mo ago`,
    };
  }
  if (ageMonths > 18) {
    return {
      confidence: "low",
      note: `Last verified ${Math.round(ageMonths)}mo ago — stale`,
    };
  }
  if (corroborations >= 3) {
    return { confidence: "high", note: `${corroborations} corroborating sources` };
  }
  if (corroborations >= 1) {
    return { confidence: "medium", note: `${corroborations} source(s)` };
  }
  return { confidence: "low", note: "Single source or uncorroborated" };
}

export function executeConfidence(
  params: ConfidenceParams,
  store: GBrainStore
): ConfidenceResult {
  const startMs = Date.now();
  const { entity } = params;

  const matches = store.searchByName(entity);
  if (matches.length === 0) {
    return { entity, path: null, claims: [], queryTimeMs: Date.now() - startMs };
  }

  const match = matches[0];
  if (!match) {
    return { entity, path: null, claims: [], queryTimeMs: Date.now() - startMs };
  }
  const page = match.page;

  // Get timeline content from indexed chunks
  const timelineChunks = store.getTimelineChunks(page.id);
  const timelineText = timelineChunks.map((c) => c.content).join("\n");

  const lastVerified = mostRecentDate(timelineText);

  // Parse frontmatter sources for attribution
  const frontmatter = JSON.parse(page.frontmatter) as Record<string, unknown>;
  const fmSources = Array.isArray(frontmatter["sources"])
    ? (frontmatter["sources"] as string[])
    : [];

  const factualSentences = splitSentences(page.compiled_truth).filter(isFactualClaim);

  const claims: ClaimConfidence[] = factualSentences.slice(0, 20).map((sentence) => {
    const corroborations = countCorroborations(sentence, timelineText);
    const { confidence, note } = scoreConfidence(corroborations, lastVerified);

    const sources: string[] =
      corroborations > 0 && fmSources.length > 0
        ? fmSources.slice(0, Math.min(corroborations, fmSources.length))
        : ["compiled_truth"];

    return {
      claim: sentence,
      confidence,
      sources,
      lastVerified: corroborations > 0 ? lastVerified : null,
      note,
    };
  });

  return {
    entity: page.title,
    path: page.path,
    claims,
    queryTimeMs: Date.now() - startMs,
  };
}

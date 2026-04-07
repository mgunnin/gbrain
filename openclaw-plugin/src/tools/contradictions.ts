import type { GBrainStore, PageRow } from "../indexer/store.js";

export interface ContradictionsParams {
  entity?: string;
  scope?: string;
  limit?: number;
}

export interface Contradiction {
  pagePath: string;
  field: string;
  value1: string;
  source1: string;
  value2: string;
  source2: string;
  severity: "high" | "medium" | "low";
}

export interface ContradictionsResult {
  contradictions: Contradiction[];
  pagesChecked: number;
  queryTimeMs: number;
}

interface NumericFact {
  value: string;
  normalizedNumber: number;
  metric: string;
  source: string;
  date?: string;
}

const METRIC_KEYWORDS = [
  "ARR", "MRR", "revenue", "funding", "valuation",
  "headcount", "employees", "raised", "round", "users", "customers",
];

// Matches currency/numeric patterns: $1.2M, 500K, 2.3 million, 45%, etc.
const NUMERIC_RE = /\$?(\d[\d,.]*)(\s*(?:M|B|K|million|billion|thousand|%))?/gi;

function extractNumericFacts(text: string, source: string): NumericFact[] {
  const facts: NumericFact[] = [];

  for (const line of text.split("\n")) {
    const lineUpper = line.toUpperCase();
    const metric = METRIC_KEYWORDS.find((m) => lineUpper.includes(m.toUpperCase()));
    if (!metric) continue;

    const dateMatch = line.match(/\d{4}-\d{2}-\d{2}/);
    const date = dateMatch ? dateMatch[0] : undefined;

    NUMERIC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NUMERIC_RE.exec(line)) !== null) {
      const rawStr = m[1].replace(/,/g, "");
      const rawNumber = parseFloat(rawStr);
      if (isNaN(rawNumber) || rawNumber === 0) continue;

      const unit = (m[2] ?? "").trim().toUpperCase();
      let normalizedNumber = rawNumber;
      if (unit === "M" || unit === "MILLION") normalizedNumber = rawNumber * 1_000_000;
      else if (unit === "B" || unit === "BILLION") normalizedNumber = rawNumber * 1_000_000_000;
      else if (unit === "K" || unit === "THOUSAND") normalizedNumber = rawNumber * 1_000;

      facts.push({
        value: m[0].trim(),
        normalizedNumber,
        metric,
        source,
        date,
      });
    }
  }

  return facts;
}

function detectPageContradictions(
  page: PageRow,
  timelineText: string
): Contradiction[] {
  const contradictions: Contradiction[] = [];
  const allFacts: NumericFact[] = [
    ...extractNumericFacts(page.compiled_truth, "compiled_truth"),
    ...extractNumericFacts(timelineText, "timeline"),
  ];

  // Group by metric
  const byMetric = new Map<string, NumericFact[]>();
  for (const fact of allFacts) {
    const group = byMetric.get(fact.metric) ?? [];
    group.push(fact);
    byMetric.set(fact.metric, group);
  }

  for (const [metric, facts] of byMetric) {
    if (facts.length < 2) continue;

    for (let i = 0; i < facts.length - 1; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const f1 = facts[i];
        const f2 = facts[j];
        if (!f1 || !f2) continue;

        const maxVal = Math.max(f1.normalizedNumber, f2.normalizedNumber);
        if (maxVal === 0) continue;

        const diff = Math.abs(f1.normalizedNumber - f2.normalizedNumber) / maxVal;
        if (diff <= 0.1) continue; // within 10% — not a contradiction

        const severity: Contradiction["severity"] =
          diff > 0.5 ? "high" : diff > 0.2 ? "medium" : "low";

        contradictions.push({
          pagePath: page.path,
          field: metric,
          value1: f1.value,
          source1: f1.source + (f1.date ? ` (${f1.date})` : ""),
          value2: f2.value,
          source2: f2.source + (f2.date ? ` (${f2.date})` : ""),
          severity,
        });
      }
    }
  }

  return contradictions;
}

export function executeContradictions(
  params: ContradictionsParams,
  store: GBrainStore
): ContradictionsResult {
  const startMs = Date.now();
  const { entity, scope, limit = 10 } = params;

  let pagesToCheck: PageRow[];

  if (entity) {
    const matches = store.searchByName(entity);
    if (matches.length === 0) {
      return { contradictions: [], pagesChecked: 0, queryTimeMs: Date.now() - startMs };
    }
    const match = matches[0];
    pagesToCheck = match ? [match.page] : [];
  } else if (scope) {
    pagesToCheck = store
      .getAllPages()
      .filter((p) => p.path.startsWith(scope + "/"));
  } else {
    pagesToCheck = store.getAllPages();
  }

  const contradictions: Contradiction[] = [];

  for (const page of pagesToCheck) {
    if (contradictions.length >= limit) break;

    // Get timeline content from indexed chunks
    const timelineChunks = store.getTimelineChunks(page.id);
    const timelineText = timelineChunks.map((c) => c.content).join("\n");

    const found = detectPageContradictions(page, timelineText);
    contradictions.push(...found);
  }

  return {
    contradictions: contradictions.slice(0, limit),
    pagesChecked: pagesToCheck.length,
    queryTimeMs: Date.now() - startMs,
  };
}

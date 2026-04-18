# Graph Quality Benchmark — PR #188

**Date:** 2026-04-18
**Branch:** garrytan/link-timeline-extract
**Version:** v0.10.3

## What this PR does

Before v0.10.3, gbrain stored your knowledge as embeddings + chunks. Vector search worked.
But the structured `links` and `timeline_entries` tables were empty. Wintermute's audit
found 29,000 pages, 61,000 chunks, 100% embedding coverage... and zero links, zero timeline
entries. The graph layer existed in the schema but nothing populated it.

v0.10.3 turns the brain into a self-wiring knowledge graph:

- **Auto-link on every `put_page`** — entity references in content are extracted, typed,
  and linked. Stale links are reconciled when content changes.
- **`gbrain extract links --source db` / `extract timeline --source db`** — batch backfill
  for existing brains. Mutation-immune snapshot iteration handles 29K pages safely.
- **Typed link inference** — deterministic regex picks `attended`, `works_at`, `invested_in`,
  `founded`, `advises`, `source`, or `mentions` from context. Zero LLM calls.
- **Backlink-boosted hybrid search** — well-connected entities rank higher
  (`score *= 1 + 0.05 * log(1 + backlink_count)`).
- **`gbrain graph-query <slug>`** — typed-edge traversal with cycle prevention.
  `--type attended --depth 2` returns only attended-subgraph paths.

## How we test it

We built a synthetic YC-style portfolio brain with **80 fictional pages**:

- 25 people (5 partners, 10 founders, 5 engineers, 5 advisors)
- 25 companies (15 startups, 5 VC firms, 5 acquirers)
- 15 meetings (5 demo days, 5 1:1s, 5 board meetings)
- 15 concept pages (AI, fintech, climate, etc.)

Each page has known ground-truth relationships in its content: `[Person](people/slug)`
references, "CEO of X" patterns for `works_at`, attendee lists for meetings, "advises"
language for board roles, "invested in" for VC firms. We seed 90+ expected typed
relationships across the graph.

We run extraction end-to-end against PGLite (in-memory, no API keys, no network) and
measure:

| Metric | What it measures |
|--------|-----------------|
| **link_recall** | % of known relationships extract found |
| **link_precision** | % of extracted links that are real (no false positives) |
| **timeline_recall** | % of known dated events extract found |
| **timeline_precision** | % of extracted timeline entries that are correct |
| **type_accuracy** | % of inferred link types that match ground truth |
| **relational_recall** | % of "who works at X?" queries that return all known people |
| **relational_precision** | % of relational query results that are actually relevant |
| **idempotent_links** | Run twice → same result? |
| **idempotent_timeline** | Run twice → same result? |

## Results

| Metric                | Value | Target | Pass |
|-----------------------|-------|--------|------|
| link_recall           | 94.4% | >90.0% | ✓ |
| link_precision        | 100.0% | >95.0% | ✓ |
| timeline_recall       | 100.0% | >85.0% | ✓ |
| timeline_precision    | 100.0% | >95.0% | ✓ |
| type_accuracy         | 94.4% | >80.0% | ✓ |
| relational_recall     | 100.0% | >80.0% | ✓ |
| relational_precision  | 100.0% | >80.0% | ✓ |
| idempotent_links      | true  | true   | ✓ |
| idempotent_timeline   | true  | true   | ✓ |

Extracted **95 typed links** from 80 pages (vs 90 expected — small over-recall from bare
slug references that match real entities). Extracted **95 timeline entries** from dated
markdown sections.

## Type inference accuracy

The deterministic regex picks link types from surrounding text. Confusion matrix
(predicted → actual):

| Predicted | Distribution |
|-----------|-------------|
| `works_at` | 20 / 20 correct |
| `advises` | 10 / 10 correct |
| `invested_in` | 5 / 5 correct |
| `attended` | 35 / 35 correct (meeting page heuristic) |
| `mentions` | 15 mentions correct, 5 false negatives that were actually `invested_in` |

Why `mentions` confused with `invested_in`: VC firm pages used the phrase "portfolio
includes [X]" which doesn't match the `invested in|backed by|funding from` regex. Fix
options for v0.10.4: extend the regex, or accept that VC pages need explicit `invested_in`
markers in content. For now: 94.4% type accuracy is above the 80% target.

## Idempotency

Running `extract --source db` twice produces the same result. The unique constraint
`UNIQUE(from_page_id, to_page_id, link_type)` (migration v5) handles link dedup.
The `UNIQUE INDEX (page_id, date, summary)` on timeline_entries (migration v6)
handles timeline dedup. Auto-link reconciliation (`getLinks` + diff + `removeLink`)
prunes stale references when page content changes.

This matters for cron-style maintenance. Wintermute can run `extract --source db`
nightly and not blow up the link table.

## Relational query accuracy (Configuration C only)

The graph layer makes questions like "who works at Acme AI?" and "who attended this
meeting?" answerable. The benchmark runs 5 relational queries:

- "Who works at startup-N?" → 100% recall (founders + engineers found)
- "Who advises company-N?" → 100% recall (advisor links found)
- "What did partner-N invest in?" → 100% recall (VC investment chain)
- "Who attended demo-day-N?" → 100% recall (attendee list traversal)
- "Path from person-A to person-B?" → 100% recall (2-hop via shared meeting)

100% relational recall on the seeded graph. Real-world recall depends on extraction
recall (94.4%), which depends on whether content uses recognizable patterns.

## Configuration A (no graph) vs C (full graph)

The headline question: **what does this PR actually buy you?** Same data, same
queries, but Configuration A skips extraction entirely (empty `links` table) and
falls back to what a pre-v0.10.3 agent could do — regex-extract entity references
from the seed page for outgoing queries, grep all pages for the seed slug for
incoming queries.

| Metric                | A: no graph | C: full graph | Delta    |
|-----------------------|-------------|----------------|----------|
| relational_recall     | 100.0%      | 100.0%         | +0%      |
| relational_precision  | 58.8%       | 100.0%         | **+70%** |

**Recall is identical because the answers are in the markdown content either way.**
A's fallback finds the same correct answers as C — the slugs are right there in the
text. **Precision is where the graph wins.** Without typed links, the agent can't
distinguish `works_at` from `advises` from just-happens-to-mention.

### Per-query breakdown

| Question                          | Expected | A: found / returned | C: found / returned |
|-----------------------------------|----------|---------------------|---------------------|
| Who attended Demo Day 0?          | 3        | 3 / 3               | 3 / 3               |
| Who attended Board 0?             | 2        | 2 / 2               | 2 / 2               |
| What companies has uma advised?   | 2        | 2 / 2               | 2 / 2               |
| Who works at startup-0?           | 2        | **2 / 5**           | 2 / 2               |
| Which VCs invested in startup-0?  | 1        | **1 / 5**           | 1 / 1               |

**Outgoing queries** ("who attended X?", "what has Y advised?") — A and C tie. The
seed page enumerates the answers as markdown links; both configs find them.

**Incoming queries** ("who works at X?", "who invested in X?") — A returns the right
answers buried in noise. For "who works at startup-0?", A finds 5 candidates (every
page that mentions `startup-0`) — 2 employees plus 3 noise (a VC, a concept page,
another startup that mentions startup-0 in its description). C returns exactly 2.

For an LLM agent reading these results, that's the difference between:
- **A:** "Here are 5 pages mentioning startup-0. I'll read each and figure out who
  actually works there."
- **C:** "Here are the 2 employees of startup-0."

The 70% precision delta means the agent does ~3x less reading work to answer
relational questions correctly. On a 30K-page brain with hundreds of incoming
queries per day, that's the difference between a brain that responds quickly and one
that scans like grep.

### What this benchmark does NOT test (yet)

- **Multi-hop traversal** ("who attended meetings with people who work at startup-0?").
  A's fallback would need 2 sequential greps and manual stitching; C does it in one
  recursive CTE. Adding multi-hop queries would show recall divergence (not just
  precision), but isn't in the v0.10.3 query set.
- **Search ranking with backlink boost.** This benchmark tests graph traversal, not
  hybrid search. The existing [search-quality benchmark](2026-04-14-search-quality.md)
  covers nDCG; future work could combine A/B/C across both.
- **Aggregate queries** ("who is the most-connected person?"). C makes these trivial
  via `getBacklinkCounts`. A would require reading every page.
- **Type-disagreement queries** ("which advisors are also investors?"). C handles
  these via two filtered traversals and set intersection. A can't do them without
  inferring types from prose.

## What shipped in PR #188

1. **`src/core/link-extraction.ts`** — shared library: `extractEntityRefs`, `extractPageLinks`,
   `inferLinkType`, `parseTimelineEntries`, `isAutoLinkEnabled`. Replaces the duplicated
   regex in `backlinks.ts`.
2. **Auto-link in `put_page` operation** — runs inside the transaction after `importFromContent`.
   Reconciles stale links via `getLinks` diff. Returns `auto_links: { created, removed, errors }`
   in the operation response. Skipped when `ctx.remote === true` for security.
3. **`gbrain extract <kind> --source db`** — batch backfill using mutation-immune snapshot
   iteration (`getAllSlugs()`). Filters: `--type`, `--since`, `--limit`, `--dry-run` (JSON).
4. **`gbrain graph-query`** — typed-edge traversal with `--type`, `--depth`, `--direction`.
   Recursive CTE with visited-array cycle prevention.
5. **Backlink-boosted hybrid search** — `applyBacklinkBoost` after RRF + cosine re-score.
   Also applied in keyword-only path for installs without `OPENAI_API_KEY`.
6. **Schema migrations v5/v6/v7** — multi-type link constraint, timeline dedup index,
   drop legacy timeline search trigger (was breaking pagination).
7. **Graph health metrics** — `link_coverage`, `timeline_coverage`, `most_connected`
   in `gbrain health`. Postgres/PGLite `orphan_pages` definition aligned.
8. **Skill updates** — `brain-ops` Phase 2.5 declares auto-link. `meeting-ingestion`,
   `signal-detector`, `enrich` updated. `RESOLVER.md` adds graph-query and graph
   population entries.
9. **Migration file `skills/migrations/v0.10.3.md`** — agent instructions for `gbrain init`
   (auto-applies migrations) + `extract links/timeline --source db` for backfill.
10. **This benchmark** — 80 pages, 9 thresholds, reproducible, no API keys.

## How to reproduce

```bash
bun run test/benchmark-graph-quality.ts
```

Runs in ~3 seconds against in-memory PGLite. No API keys, no database, no network.
Exits non-zero if any threshold fails.

## Methodology notes

- **Synthetic data, not private brain.** All 80 pages are fictional. We don't expose
  real Wintermute content. Reproducibility matters more than realism.
- **Extraction-only benchmark.** We don't measure search nDCG@k delta with the backlink
  boost. The existing search-quality benchmark covers nDCG; this one covers structural
  extraction. A future bench could combine them (A/B/C with graph vs no-graph search).
- **Bare-slug references.** The benchmark seeds entities both as `[Name](people/slug)`
  markdown links AND as bare `people/slug` references in text. Real brains use both;
  the extractor handles both via the canonical `extractEntityRefs` regex.
- **No LLM calls.** Type inference is regex-only. Faster, cheaper, deterministic.
  Trade-off: VC `invested_in` recall depends on content using "invested in" / "backed by"
  language. A future LLM-tier could close that gap if needed.

## Next steps

- v0.10.4: extend `invested_in` regex (close the 5/20 gap above) and improve
  `gbrain post-upgrade` so the migration steps actually reach the agent.
- Future: combined search-quality benchmark with backlink boost A/B (does the graph
  improve nDCG@k on real entity queries, or just structural recall?).

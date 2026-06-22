/**
 * Canonical orphan/linkability exclusions.
 *
 * These are pages where no inbound/outbound links are expected and therefore
 * should not drag the curation/brain score: generated logs, raw transcripts,
 * import artifacts, receipts, templates, sidecars, and other pseudo content.
 *
 * Keep this shared between:
 *   - `gbrain orphans` / doctor orphan_ratio (human-facing list)
 *   - engine.getHealth() brain-score no-orphans component
 * so the remediation planner and doctor do not disagree about what is
 * genuinely linkable knowledge.
 */

/** Slug suffixes that are always auto-generated root files. */
export const AUTO_SUFFIX_PATTERNS = ['/_index', '/log'] as const;

/** Page slugs that are pseudo-pages by convention. */
export const PSEUDO_SLUGS = ['_atlas', '_index', '_stats', '_orphans', '_scratch', 'claude'] as const;

/** Slug segment that marks raw sources. */
export const RAW_SEGMENT = '/raw/';

/** Slug prefixes where no inbound links is expected. */
export const DENY_PREFIXES = [
  'output/',
  'dashboards/',
  'scripts/',
  'templates/',
  'openclaw/config/',
] as const;

/** First slug segments where no inbound links is expected. */
export const FIRST_SEGMENT_EXCLUSIONS = [
  'scratch',
  'thoughts',
  'catalog',
  'entities',
  'raw',
  'atoms',
  'skills',
  // Generated/imported operational corpora. These should remain searchable
  // when explicitly asked for, but their lack of incoming links is not a
  // knowledge-graph quality failure.
  'artifacts',
  'extracts',
  'transcripts',
  '.sources',
  // Agent operational logs/state: durable audit trail, not curated wiki nodes.
  'agent-ella',
  'agent-lyra',
  'agent-shared',
  'memory',
  'lyra',
  'derived',
] as const;

const PSEUDO_SET = new Set<string>(PSEUDO_SLUGS);
const FIRST_SEGMENT_SET = new Set<string>(FIRST_SEGMENT_EXCLUSIONS);

/**
 * Returns true if a slug should be excluded from orphan reporting/scoring by
 * default. These are pages where having no inbound links is expected / not a
 * content problem.
 */
export function shouldExcludeFromOrphanScoring(slug: string): boolean {
  if (PSEUDO_SET.has(slug)) return true;

  for (const suffix of AUTO_SUFFIX_PATTERNS) {
    if (slug.endsWith(suffix)) return true;
  }

  if (slug.includes(RAW_SEGMENT)) return true;

  for (const prefix of DENY_PREFIXES) {
    if (slug.startsWith(prefix)) return true;
  }

  const firstSegment = slug.split('/')[0];
  return FIRST_SEGMENT_SET.has(firstSegment);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlLike(value: string): string {
  return sqlString(value.replace(/[%_\\]/g, (m) => `\\${m}`));
}

/**
 * Static SQL predicate for engine.getHealth(). Constants above are trusted code,
 * not user input; callers splice this literal into fixed SQL strings.
 */
export function orphanScoringExclusionSql(alias = 'p'): string {
  const slug = `${alias}.slug`;
  const pseudo = PSEUDO_SLUGS.map(sqlString).join(', ');
  const firstSegments = FIRST_SEGMENT_EXCLUSIONS.map(sqlString).join(', ');
  const denyPrefixes = DENY_PREFIXES
    .map((prefix) => `${slug} LIKE ${sqlLike(`${prefix}%`)} ESCAPE '\\'`)
    .join(' OR ');
  const suffixes = AUTO_SUFFIX_PATTERNS
    .map((suffix) => `${slug} LIKE ${sqlLike(`%${suffix}`)} ESCAPE '\\'`)
    .join(' OR ');

  return `NOT (
    ${slug} IN (${pseudo})
    OR ${suffixes}
    OR ${slug} LIKE ${sqlLike(`%${RAW_SEGMENT}%`)} ESCAPE '\\'
    OR ${denyPrefixes}
    OR split_part(${slug}, '/', 1) IN (${firstSegments})
  )`;
}

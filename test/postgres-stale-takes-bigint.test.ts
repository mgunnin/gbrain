import { describe, expect, test } from 'bun:test';
import type { PgTakesDeps } from '../src/core/postgres-engine/takes.ts';
import { listStaleTakes } from '../src/core/postgres-engine/takes.ts';

describe('Postgres stale take row normalization', () => {
  test('converts postgres.js BIGINT text ids before embedding writes', async () => {
    const sql = async () => [
      {
        take_id: '1535',
        page_slug: 'memory/example',
        row_num: 1,
        claim: 'A claim',
      },
    ];
    const deps = { sql } as unknown as PgTakesDeps;

    await expect(listStaleTakes(deps)).resolves.toEqual([
      {
        take_id: 1535,
        page_slug: 'memory/example',
        row_num: 1,
        claim: 'A claim',
      },
    ]);
  });
});

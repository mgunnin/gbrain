import { readdirSync, statSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import { cpus, totalmem } from 'os';
import type { BrainEngine } from '../core/engine.ts';
import { PostgresEngine } from '../core/postgres-engine.ts';
import { importFile } from '../core/import-file.ts';
import { loadConfig } from '../core/config.ts';

function defaultWorkers(): number {
  const cpuCount = cpus().length;
  const memGB = totalmem() / (1024 ** 3);
  // Network-bound, so we can go higher than CPU count.
  // Cap by: DB pool (leave 2 for other queries), CPU, memory.
  const byPool = 8;
  const byCpu = Math.max(2, cpuCount);
  const byMem = Math.floor(memGB * 2);
  return Math.min(byPool, byCpu, byMem);
}

export async function runImport(engine: BrainEngine, args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const noEmbed = args.includes('--no-embed');
  const workersArg = args.find((a, i) => args[i - 1] === '--workers');
  const workerCount = workersArg ? parseInt(workersArg, 10) : 1;

  if (!dir) {
    console.error('Usage: gbrain import <dir> [--no-embed] [--workers N]');
    process.exit(1);
  }

  // Collect all .md files
  const files = collectMarkdownFiles(dir);
  console.log(`Found ${files.length} markdown files`);

  // Determine actual worker count
  const actualWorkers = workerCount > 1 ? workerCount : 1;
  if (actualWorkers > 1) {
    console.log(`Using ${actualWorkers} parallel workers`);
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;
  let chunksCreated = 0;
  const importedSlugs: string[] = [];
  const errorCounts: Record<string, number> = {};
  const startTime = Date.now();

  function logProgress() {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed > 0 ? Math.round(processed / elapsed) : 0;
    const remaining = rate > 0 ? Math.round((files.length - processed) / rate) : 0;
    const pct = Math.round((processed / files.length) * 100);
    console.log(`[gbrain import] ${processed}/${files.length} (${pct}%) | ${rate} files/sec | imported: ${imported} | skipped: ${skipped} | errors: ${errors} | ETA: ${remaining}s`);
  }

  async function processFile(eng: BrainEngine, filePath: string) {
    const relativePath = relative(dir, filePath);
    try {
      const result = await importFile(eng, filePath, relativePath, { noEmbed });
      if (result.status === 'imported') {
        imported++;
        chunksCreated += result.chunks;
        importedSlugs.push(result.slug);
      } else {
        skipped++;
        if (result.error && result.error !== 'unchanged') {
          console.error(`  Skipped ${relativePath}: ${result.error}`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const errorKey = msg.replace(/"[^"]*"/g, '""');
      errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
      if (errorCounts[errorKey] <= 5) {
        console.error(`  Warning: skipped ${relativePath}: ${msg}`);
      } else if (errorCounts[errorKey] === 6) {
        console.error(`  (suppressing further "${errorKey.slice(0, 60)}..." errors)`);
      }
      errors++;
      skipped++;
    }
    processed++;
    if (processed % 100 === 0 || processed === files.length) logProgress();
  }

  if (actualWorkers > 1) {
    // Parallel: create per-worker engine instances with small pool
    const config = loadConfig();
    const workerEngines = await Promise.all(
      Array.from({ length: actualWorkers }, async () => {
        const eng = new PostgresEngine();
        await eng.connect({ database_url: config.database_url!, poolSize: 2 });
        return eng;
      })
    );

    const queue = [...files];
    await Promise.all(workerEngines.map(async (eng) => {
      while (queue.length > 0) {
        const file = queue.shift()!;
        await processFile(eng, file);
      }
    }));

    await Promise.all(workerEngines.map(e => e.disconnect()));
  } else {
    // Sequential: use the provided engine
    for (const filePath of files) {
      await processFile(engine, filePath);
    }
  }

  // Error summary
  for (const [err, count] of Object.entries(errorCounts)) {
    if (count > 5) {
      console.error(`  ${count} files failed: ${err.slice(0, 100)}`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nImport complete (${totalTime}s):`);
  console.log(`  ${imported} pages imported`);
  console.log(`  ${skipped} pages skipped (${skipped - errors} unchanged, ${errors} errors)`);
  console.log(`  ${chunksCreated} chunks created`);

  // Log the ingest
  await engine.logIngest({
    source_type: 'directory',
    source_ref: dir,
    pages_updated: importedSlugs,
    summary: `Imported ${imported} pages, ${skipped} skipped, ${chunksCreated} chunks`,
  });

  // Import → sync continuity: write sync checkpoint if this is a git repo
  try {
    if (existsSync(join(dir, '.git'))) {
      const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      await engine.setConfig('sync.last_commit', head);
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await engine.setConfig('sync.repo_path', dir);
    }
  } catch {
    // Not a git repo or git not available, skip checkpoint
  }
}

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      // Skip hidden dirs and .raw dirs
      if (entry.startsWith('.')) continue;

      const full = join(d, entry);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md')) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files.sort();
}

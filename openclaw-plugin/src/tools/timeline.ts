import { execSync } from "child_process";
import type { GBrainStore } from "../indexer/store.js";

export interface TimelineParams {
  since: string;
  until?: string;
  entity?: string;
  scope?: string;
}

export interface TimelineEntry {
  date: string;
  path: string;
  title: string;
  type: string;
  changeType: "added" | "modified" | "deleted";
  commitMessage: string;
  timelineExcerpt: string;
}

export interface TimelineResult {
  entries: TimelineEntry[];
  queryTimeMs: number;
}

/** Convert relative date strings to ISO date strings. */
function parseRelativeDate(since: string): string {
  const now = new Date();
  const lower = since.toLowerCase().trim();

  if (lower === "this week") {
    const day = now.getDay(); // 0=Sunday
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diffToMonday);
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString();
  }

  const daysMatch = lower.match(/^(\d+)d$/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const d = new Date(now);
    d.setDate(d.getDate() - days);
    return d.toISOString();
  }

  // Assume it's already an ISO date string
  return since;
}

interface GitCommit {
  hash: string;
  date: string;
  subject: string;
  files: Array<{ path: string; changeType: "added" | "modified" | "deleted" }>;
}

function parseGitLog(
  brainPath: string,
  sinceDate: string,
  untilDate?: string
): GitCommit[] {
  let cmd = `git log --since="${sinceDate}"`;
  if (untilDate) cmd += ` --until="${untilDate}"`;
  // Use a sentinel prefix so we can reliably distinguish commit lines from file lines
  cmd += ` --pretty=format:"COMMIT|%H|%ai|%s" --name-status -- "*.md"`;

  let output: string;
  try {
    output = execSync(cmd, {
      cwd: brainPath,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).toString();
  } catch {
    return [];
  }

  const commits: GitCommit[] = [];
  let current: GitCommit | null = null;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("COMMIT|")) {
      if (current) commits.push(current);
      const rest = trimmed.slice("COMMIT|".length);
      const pipeIdx1 = rest.indexOf("|");
      const pipeIdx2 = rest.indexOf("|", pipeIdx1 + 1);
      const hash = pipeIdx1 >= 0 ? rest.slice(0, pipeIdx1) : rest;
      const date = pipeIdx2 >= 0 ? rest.slice(pipeIdx1 + 1, pipeIdx2) : "";
      const subject = pipeIdx2 >= 0 ? rest.slice(pipeIdx2 + 1) : "";
      current = { hash, date, subject, files: [] };
    } else if (current) {
      // Name-status lines: "M\tfile.md", "A\tfile.md", "D\tfile.md", "R100\told.md\tnew.md"
      const tabIdx = trimmed.indexOf("\t");
      if (tabIdx !== -1) {
        const statusCode = trimmed.slice(0, tabIdx);
        const rest = trimmed.slice(tabIdx + 1);
        // For renames, take the new path (after second tab)
        const secondTab = rest.indexOf("\t");
        const filePath = secondTab >= 0 ? rest.slice(secondTab + 1) : rest;

        if (filePath.endsWith(".md")) {
          let changeType: "added" | "modified" | "deleted" = "modified";
          if (statusCode === "A") changeType = "added";
          else if (statusCode === "D") changeType = "deleted";
          current.files.push({ path: filePath, changeType });
        }
      }
    }
  }

  if (current) commits.push(current);
  return commits;
}

function extractTimelineExcerpt(compiledTruth: string, maxChars = 200): string {
  // Pull the first few timeline-style bullet lines from compiled_truth
  const lines = compiledTruth.split("\n");
  const excerptLines: string[] = [];

  for (const line of lines) {
    if (/^- \*\*\d{4}-\d{2}-\d{2}/.test(line)) {
      excerptLines.push(line);
      if (excerptLines.length >= 3) break;
    }
  }

  const excerpt = excerptLines.join("\n");
  return excerpt.length > maxChars ? excerpt.slice(0, maxChars) + "…" : excerpt;
}

export function executeTimeline(
  params: TimelineParams,
  store: GBrainStore,
  brainPath: string
): TimelineResult {
  const startMs = Date.now();
  const { since, until, entity, scope } = params;

  const sinceDate = parseRelativeDate(since);
  const commits = parseGitLog(brainPath, sinceDate, until);

  // Flatten commits into per-file entries
  const fileEntries: Array<{
    date: string;
    path: string;
    changeType: "added" | "modified" | "deleted";
    commitMessage: string;
  }> = [];

  for (const commit of commits) {
    for (const file of commit.files) {
      fileEntries.push({
        date: commit.date,
        path: file.path,
        changeType: file.changeType,
        commitMessage: commit.subject,
      });
    }
  }

  // Resolve entity filter to a set of relevant paths
  let entityPaths: Set<string> | null = null;
  if (entity) {
    const matches = store.searchByName(entity);
    if (matches.length > 0) {
      const matched = matches[0];
      if (matched) {
        entityPaths = new Set<string>([matched.page.path]);
        // Also include pages this entity mentions
        const edges = store.getEdgesFrom(matched.page.id);
        for (const e of edges) entityPaths.add(e.path);
      }
    }
  }

  const entries: TimelineEntry[] = [];

  for (const entry of fileEntries) {
    // Scope filter: directory prefix
    if (scope) {
      const normalizedPath = entry.path.replace(/\\/g, "/");
      if (!normalizedPath.startsWith(scope + "/")) continue;
    }

    // Entity filter
    if (entityPaths !== null && !entityPaths.has(entry.path)) continue;

    // Look up the page in the index for title and type
    const page = store.getPageByPath(entry.path);

    let timelineExcerpt = "";
    if (page && entry.changeType !== "deleted") {
      timelineExcerpt = extractTimelineExcerpt(page.compiled_truth);
    }

    entries.push({
      date: entry.date,
      path: entry.path,
      title: page?.title ?? entry.path,
      type: page?.type ?? "unknown",
      changeType: entry.changeType,
      commitMessage: entry.commitMessage,
      timelineExcerpt,
    });
  }

  return { entries, queryTimeMs: Date.now() - startMs };
}

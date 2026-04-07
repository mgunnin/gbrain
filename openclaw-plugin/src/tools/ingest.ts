import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { parseMarkdown } from "../indexer/parser.js";
import { chunkPage } from "../indexer/chunker.js";
import { embedTexts } from "../indexer/embedder.js";
import type { GBrainStore } from "../indexer/store.js";
import type { GBrainConfig } from "../types/config.js";

export interface IngestParams {
  path: string;
  content?: string;
  timelineEntry?: string;
  compiledTruthUpdate?: string;
}

export interface IngestResult {
  path: string;
  action: "created" | "updated_timeline" | "updated_truth" | "created_with_content";
  indexStatus: "indexed" | "skipped" | "error";
  errorMessage?: string;
}

/**
 * Split a raw markdown file into its YAML frontmatter and body.
 * The frontmatter is delimited by opening and closing "---" lines.
 */
function splitFrontmatterAndBody(raw: string): { front: string; body: string } {
  if (!raw.startsWith("---")) {
    return { front: "", body: raw };
  }
  // Find the newline after the opening ---
  const firstNl = raw.indexOf("\n");
  if (firstNl === -1) return { front: raw, body: "" };

  const afterOpen = raw.slice(firstNl + 1);
  const closingMatch = /^---\s*$/m.exec(afterOpen);
  if (!closingMatch || closingMatch.index === undefined) {
    return { front: raw, body: "" };
  }

  const closingEnd = firstNl + 1 + closingMatch.index + closingMatch[0].length;
  return {
    front: raw.slice(0, closingEnd),
    body: raw.slice(closingEnd),
  };
}

/** Timeline separator patterns (searched in the body, after frontmatter). */
const SEPARATOR_PATTERNS = [
  /^---\s*$/m,
  /^## Timeline\s*$/im,
  /^## \d{4}/m,
];

function findTimelineSeparator(body: string): { index: number; length: number } | null {
  for (const pattern of SEPARATOR_PATTERNS) {
    const match = pattern.exec(body);
    if (match && match.index !== undefined) {
      return { index: match.index, length: match[0].length };
    }
  }
  return null;
}

/**
 * Prepend a new timeline entry (reverse-chronological) right after the timeline
 * separator. If no separator exists, appends a new "---" section.
 */
function prependTimelineEntry(raw: string, entry: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const formattedEntry = `- **${today}**: ${entry}`;

  const { front, body } = splitFrontmatterAndBody(raw);
  const sep = findTimelineSeparator(body);

  if (!sep) {
    // No timeline section — append one
    return `${raw.trimEnd()}\n\n---\n\n${formattedEntry}\n`;
  }

  const sepEnd = sep.index + sep.length;
  const beforeTimeline = body.slice(0, sepEnd);
  const afterTimeline = body.slice(sepEnd);

  return `${front}${beforeTimeline}\n\n${formattedEntry}${afterTimeline}`;
}

/**
 * Replace the compiled truth section (everything between frontmatter and the
 * timeline separator), preserving frontmatter and timeline.
 */
function replaceCompiledTruth(raw: string, newTruth: string): string {
  const { front, body } = splitFrontmatterAndBody(raw);
  const sep = findTimelineSeparator(body);

  if (!sep) {
    // No timeline — replace entire body
    return `${front}\n\n${newTruth.trimEnd()}\n`;
  }

  const timeline = body.slice(sep.index);
  return `${front}\n\n${newTruth.trimEnd()}\n\n${timeline}`;
}

export async function executeIngest(
  params: IngestParams,
  store: GBrainStore,
  config: GBrainConfig,
  apiKey: string
): Promise<IngestResult> {
  const { path: relativePath, content, timelineEntry, compiledTruthUpdate } = params;
  const fullPath = join(config.brainPath, relativePath);

  let action: IngestResult["action"];

  try {
    const fileExists = existsSync(fullPath);

    if (fileExists && timelineEntry) {
      const raw = readFileSync(fullPath, "utf-8");
      writeFileSync(fullPath, prependTimelineEntry(raw, timelineEntry), "utf-8");
      action = "updated_timeline";
    } else if (fileExists && compiledTruthUpdate) {
      const raw = readFileSync(fullPath, "utf-8");
      writeFileSync(fullPath, replaceCompiledTruth(raw, compiledTruthUpdate), "utf-8");
      action = "updated_truth";
    } else if (!fileExists && content) {
      // Ensure parent directory exists
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(fullPath, content, "utf-8");
      action = "created_with_content";
    } else if (!fileExists) {
      // Create minimal template
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const title =
        relativePath
          .split("/")
          .pop()
          ?.replace(/\.md$/, "")
          .replace(/-/g, " ") ?? relativePath;
      writeFileSync(fullPath, `---\ntitle: ${title}\n---\n\n`, "utf-8");
      action = "created";
    } else {
      // File exists, no mutation specified — nothing to do
      return { path: relativePath, action: "updated_truth", indexStatus: "skipped" };
    }
  } catch (err) {
    return {
      path: relativePath,
      action: "created",
      indexStatus: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  // Re-index the written file
  try {
    const page = parseMarkdown(fullPath, config.brainPath);
    const chunks = chunkPage(page, config.chunkMaxTokens, config.indexTimeline);
    const texts = chunks.map((c) => c.content);
    const embeddings = apiKey
      ? await embedTexts(texts, { apiKey, model: config.embeddingModel })
      : texts.map(() => [] as number[]);

    const pageId = store.upsertPage(page);
    store.replaceChunks(pageId, chunks, embeddings);
    store.upsertEdges(pageId, page.relatedPaths);

    return { path: relativePath, action, indexStatus: "indexed" };
  } catch (err) {
    return {
      path: relativePath,
      action,
      indexStatus: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

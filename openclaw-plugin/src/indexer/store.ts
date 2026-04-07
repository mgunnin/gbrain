import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type { ParsedPage } from "./parser.js";
import type { Chunk } from "./chunker.js";

export interface PageRow {
  id: number;
  path: string;
  type: string;
  title: string;
  aliases: string;
  content_hash: string;
  frontmatter: string;
  compiled_truth: string;
  updated_at: string;
  indexed_at: string;
}

export interface ChunkRow {
  id: number;
  pageId: number;
  chunkType: string;
  content: string;
  embedding: Buffer | null;
  tokenCount: number;
  position: number;
}

export interface ChunkSearchResult {
  chunkId: number;
  pageId: number;
  path: string;
  type: string;
  title: string;
  aliases: string[];
  chunkType: string;
  content: string;
  tokenCount: number;
  score: number;
  updatedAt: string;
  frontmatter: Record<string, unknown>;
}

export interface GraphEdgeRow {
  relationship: string;
  context: string;
  path: string;
  title: string;
  type: string;
  neighborPageId: number;
}

export interface StoreStats {
  pageCount: number;
  chunkCount: number;
  edgeCount: number;
  indexSizeBytes: number;
  lastSync: string | null;
  embeddingModel: string | null;
}

function embeddingToBuffer(embedding: number[]): Buffer {
  const arr = new Float64Array(embedding);
  return Buffer.from(arr.buffer);
}

function bufferToEmbedding(buf: Buffer): Float64Array {
  return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
}

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class GBrainStore {
  private db: Database.Database;

  constructor(indexPath: string) {
    const dir = dirname(indexPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(indexPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL DEFAULT 'unknown',
        title TEXT NOT NULL DEFAULT '',
        aliases TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        frontmatter TEXT NOT NULL DEFAULT '{}',
        compiled_truth TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);
      CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
      CREATE INDEX IF NOT EXISTS idx_pages_title ON pages(title);

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        chunk_type TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        token_count INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_page_id ON chunks(page_id);

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY,
        source_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        target_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        relationship TEXT NOT NULL DEFAULT 'mentions',
        context TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_page_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_page_id);

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  upsertPage(page: ParsedPage): number {
    const now = new Date().toISOString();
    const updatedAt = (page.frontmatter.updated as string) ?? now;

    const existing = this.db
      .prepare("SELECT id FROM pages WHERE path = ?")
      .get(page.relativePath) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE pages SET
            type = ?, title = ?, aliases = ?, content_hash = ?,
            frontmatter = ?, compiled_truth = ?, updated_at = ?, indexed_at = ?
          WHERE path = ?`
        )
        .run(
          page.type,
          page.title,
          JSON.stringify(page.aliases),
          page.contentHash,
          JSON.stringify(page.frontmatter),
          page.compiledTruth,
          updatedAt,
          now,
          page.relativePath
        );
      return existing.id;
    } else {
      const result = this.db
        .prepare(
          `INSERT INTO pages
            (path, type, title, aliases, content_hash, frontmatter, compiled_truth, updated_at, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          page.relativePath,
          page.type,
          page.title,
          JSON.stringify(page.aliases),
          page.contentHash,
          JSON.stringify(page.frontmatter),
          page.compiledTruth,
          updatedAt,
          now
        );
      return result.lastInsertRowid as number;
    }
  }

  replaceChunks(pageId: number, chunks: Chunk[], embeddings: number[][]): void {
    this.db.prepare("DELETE FROM chunks WHERE page_id = ?").run(pageId);

    const insert = this.db.prepare(
      `INSERT INTO chunks (page_id, chunk_type, content, embedding, token_count, position)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const insertMany = this.db.transaction(
      (items: Array<{ chunk: Chunk; embedding: number[] | undefined }>) => {
        for (const { chunk, embedding } of items) {
          const embBuf = embedding ? embeddingToBuffer(embedding) : null;
          insert.run(
            pageId,
            chunk.chunkType,
            chunk.content,
            embBuf,
            chunk.tokenCount,
            chunk.position
          );
        }
      }
    );

    insertMany(chunks.map((chunk, i) => ({ chunk, embedding: embeddings[i] })));
  }

  getPageByPath(path: string): PageRow | undefined {
    return this.db
      .prepare("SELECT * FROM pages WHERE path = ?")
      .get(path) as PageRow | undefined;
  }

  getPageById(id: number): PageRow | undefined {
    return this.db
      .prepare("SELECT * FROM pages WHERE id = ?")
      .get(id) as PageRow | undefined;
  }

  getAllPages(): PageRow[] {
    return this.db.prepare("SELECT * FROM pages").all() as PageRow[];
  }

  deletePageByPath(path: string): void {
    this.db.prepare("DELETE FROM pages WHERE path = ?").run(path);
  }

  getContentHash(path: string): string | null {
    const row = this.db
      .prepare("SELECT content_hash FROM pages WHERE path = ?")
      .get(path) as { content_hash: string } | undefined;
    return row ? row.content_hash : null;
  }

  /**
   * Brute-force cosine similarity search across all chunks that have embeddings.
   * Optionally filter by directory scope (path prefix).
   */
  searchByEmbedding(
    queryEmbedding: number[],
    opts: { scope?: string; limit?: number; excludeTimeline?: boolean }
  ): ChunkSearchResult[] {
    const { scope, limit = 5, excludeTimeline = true } = opts;

    const queryVec = new Float64Array(queryEmbedding);

    let sql = `
      SELECT c.id as chunk_id, c.page_id, c.chunk_type, c.content, c.embedding, c.token_count,
             p.path, p.type, p.title, p.aliases, p.updated_at, p.frontmatter
      FROM chunks c
      JOIN pages p ON c.page_id = p.id
      WHERE c.embedding IS NOT NULL
    `;
    const params: unknown[] = [];

    if (excludeTimeline) {
      sql += " AND c.chunk_type != 'timeline'";
    }
    if (scope && scope !== "all") {
      sql += " AND p.path LIKE ?";
      params.push(`${scope}/%`);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      chunk_id: number;
      page_id: number;
      chunk_type: string;
      content: string;
      embedding: Buffer;
      token_count: number;
      path: string;
      type: string;
      title: string;
      aliases: string;
      updated_at: string;
      frontmatter: string;
    }>;

    const scored = rows.map((row) => {
      const vec = bufferToEmbedding(row.embedding);
      const score = cosineSimilarity(queryVec, vec);
      return {
        chunkId: row.chunk_id,
        pageId: row.page_id,
        path: row.path,
        type: row.type,
        title: row.title,
        aliases: JSON.parse(row.aliases) as string[],
        chunkType: row.chunk_type,
        content: row.content,
        tokenCount: row.token_count,
        score,
        updatedAt: row.updated_at,
        frontmatter: JSON.parse(row.frontmatter) as Record<string, unknown>,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Search pages by exact or fuzzy title/alias match.
   * Returns pages sorted by match quality.
   */
  searchByName(
    name: string,
    type?: string
  ): Array<{ page: PageRow; matchType: "exact_path" | "exact_title" | "alias" | "fuzzy" }> {
    const normalizedName = name.toLowerCase().trim();
    const results: Array<{ page: PageRow; matchType: "exact_path" | "exact_title" | "alias" | "fuzzy" }> = [];

    // Exact path match (e.g. "pedro-franceschi" → "people/pedro-franceschi.md")
    const slugName = normalizedName.replace(/\s+/g, "-");
    const allPages = type && type !== "any"
      ? (this.db.prepare("SELECT * FROM pages WHERE type = ?").all(type) as PageRow[])
      : this.getAllPages();

    for (const page of allPages) {
      const filename = page.path.split("/").pop()?.replace(/\.md$/, "") ?? "";
      const titleLower = page.title.toLowerCase();
      const aliases: string[] = JSON.parse(page.aliases);

      if (filename === slugName || filename === normalizedName) {
        results.push({ page, matchType: "exact_path" });
        continue;
      }
      if (titleLower === normalizedName) {
        results.push({ page, matchType: "exact_title" });
        continue;
      }
      if (aliases.some((a) => a.toLowerCase() === normalizedName)) {
        results.push({ page, matchType: "alias" });
        continue;
      }
      // Fuzzy: title or alias contains the name
      if (
        titleLower.includes(normalizedName) ||
        aliases.some((a) => a.toLowerCase().includes(normalizedName))
      ) {
        results.push({ page, matchType: "fuzzy" });
      }
    }

    // Sort: exact_path > exact_title > alias > fuzzy
    const order = { exact_path: 0, exact_title: 1, alias: 2, fuzzy: 3 };
    results.sort((a, b) => order[a.matchType] - order[b.matchType]);
    return results;
  }

  upsertEdges(sourcePageId: number, targetPaths: string[]): void {
    const deleteExisting = this.db.prepare(
      "DELETE FROM edges WHERE source_page_id = ?"
    );
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO edges (source_page_id, target_page_id, relationship, context)
       SELECT ?, id, 'mentions', '' FROM pages WHERE path = ?`
    );

    const tx = this.db.transaction(() => {
      deleteExisting.run(sourcePageId);
      for (const targetPath of targetPaths) {
        insert.run(sourcePageId, targetPath);
      }
    });
    tx();
  }

  /** Get all edges where this page is the source (pages this page mentions). */
  getEdgesFrom(pageId: number): GraphEdgeRow[] {
    return this.db
      .prepare(
        `SELECT e.relationship, e.context, p.path, p.title, p.type, p.id as neighborPageId
         FROM edges e
         JOIN pages p ON e.target_page_id = p.id
         WHERE e.source_page_id = ?`
      )
      .all(pageId) as GraphEdgeRow[];
  }

  /** Get all edges where this page is the target (pages that mention this page). */
  getEdgesTo(pageId: number): GraphEdgeRow[] {
    return this.db
      .prepare(
        `SELECT e.relationship, e.context, p.path, p.title, p.type, p.id as neighborPageId
         FROM edges e
         JOIN pages p ON e.source_page_id = p.id
         WHERE e.target_page_id = ?`
      )
      .all(pageId) as GraphEdgeRow[];
  }

  /** Get pages that share edge targets with this page (co-occurrence). */
  getCoOccurs(pageId: number): GraphEdgeRow[] {
    return this.db
      .prepare(
        `SELECT DISTINCT 'co_occurs' as relationship, '' as context,
                p.path, p.title, p.type, p.id as neighborPageId
         FROM edges e1
         JOIN edges e2 ON e1.target_page_id = e2.target_page_id
         JOIN pages p ON e2.source_page_id = p.id
         WHERE e1.source_page_id = ? AND e2.source_page_id != ?`
      )
      .all(pageId, pageId) as GraphEdgeRow[];
  }

  /** Get all timeline chunks for a page. */
  getTimelineChunks(pageId: number): Array<{ content: string }> {
    return this.db
      .prepare(
        `SELECT content FROM chunks WHERE page_id = ? AND chunk_type = 'timeline'`
      )
      .all(pageId) as Array<{ content: string }>;
  }

  getSyncState(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM sync_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSyncState(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)"
      )
      .run(key, value);
  }

  getStats(): StoreStats {
    const pageCount = (
      this.db.prepare("SELECT COUNT(*) as n FROM pages").get() as { n: number }
    ).n;
    const chunkCount = (
      this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number }
    ).n;
    const edgeCount = (
      this.db.prepare("SELECT COUNT(*) as n FROM edges").get() as { n: number }
    ).n;
    const lastSync = this.getSyncState("last_sync_at");
    const embeddingModel = this.getSyncState("embedding_model");

    // Approximate: use SQLite page_count pragma
    const pageSize = (
      this.db.pragma("page_size") as Array<{ page_size: number }>
    )[0]?.page_size ?? 4096;
    const pageCount2 = (
      this.db.pragma("page_count") as Array<{ page_count: number }>
    )[0]?.page_count ?? 0;

    return {
      pageCount,
      chunkCount,
      edgeCount,
      indexSizeBytes: pageSize * pageCount2,
      lastSync,
      embeddingModel,
    };
  }

  close(): void {
    this.db.close();
  }
}

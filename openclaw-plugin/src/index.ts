import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { GBrainStore } from "./indexer/store.js";
import { resolveConfig } from "./types/config.js";
import { executeQuery } from "./tools/query.js";
import { executeResolve } from "./tools/resolve.js";
import { executeGraph } from "./tools/graph.js";
import { executeTimeline } from "./tools/timeline.js";
import { executeIngest } from "./tools/ingest.js";
import { executeContradictions } from "./tools/contradictions.js";
import { executeConfidence } from "./tools/confidence.js";
import { registerCli } from "./cli.js";
import { createWatcherService } from "./service.js";

definePluginEntry((api) => {
  const config = resolveConfig(api.config);
  const store = new GBrainStore(config.indexPath);
  const apiKey = process.env["VOYAGE_API_KEY"] ?? "";

  // ── Tools ────────────────────────────────────────────────────────────────

  api.registerTool({
    name: "gbrain_query",
    description:
      "Search the knowledge brain semantically. Returns ranked page excerpts with source paths. " +
      "Use for any question about people, companies, deals, meetings, projects, or concepts in the brain.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language query" }),
      scope: Type.Optional(
        Type.Union([
          Type.Literal("all"),
          Type.Literal("people"),
          Type.Literal("companies"),
          Type.Literal("deals"),
          Type.Literal("meetings"),
          Type.Literal("projects"),
          Type.Literal("yc"),
          Type.Literal("civic"),
        ], { description: "Limit search to a specific directory/type" })
      ),
      limit: Type.Optional(
        Type.Number({ default: 5, minimum: 1, maximum: 20 })
      ),
      includeTimeline: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "Include timeline entries (heavier, use when asking about history)",
        })
      ),
    }),
    async execute(_id, params) {
      const result = await executeQuery(
        {
          query: params["query"] as string,
          scope: params["scope"] as "all" | "people" | "companies" | "deals" | "meetings" | "projects" | "yc" | "civic" | undefined,
          limit: params["limit"] as number | undefined,
          includeTimeline: params["includeTimeline"] as boolean | undefined,
        },
        store,
        apiKey
      );

      const lines: string[] = [];
      lines.push(
        `Found ${result.results.length} results in ${result.queryTimeMs}ms (${result.totalIndexed} pages indexed)\n`
      );

      for (const r of result.results) {
        lines.push(`## ${r.title}`);
        lines.push(`Path: ${r.path}`);
        lines.push(`Type: ${r.type} | Score: ${r.score} | Updated: ${r.updatedAt}`);
        if (r.relatedEntities.length > 0) {
          lines.push(`Related: ${r.relatedEntities.join(", ")}`);
        }
        lines.push(`\n${r.excerpt}\n`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "gbrain_resolve",
    description:
      "Resolve a name, company, or reference to its brain page path. " +
      "Uses exact match, aliases, and embedding similarity. " +
      "Returns the page path and compiled truth summary.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Entity name to resolve (e.g. 'Pedro', 'Brex', 'the Variant deal')",
      }),
      type: Type.Optional(
        Type.Union([
          Type.Literal("person"),
          Type.Literal("company"),
          Type.Literal("deal"),
          Type.Literal("meeting"),
          Type.Literal("any"),
        ], { default: "any" })
      ),
    }),
    async execute(_id, params) {
      const result = await executeResolve(
        {
          name: params["name"] as string,
          type: params["type"] as "person" | "company" | "deal" | "meeting" | "any" | undefined,
        },
        store,
        apiKey
      );

      const lines: string[] = [];

      if (result.match) {
        const m = result.match;
        lines.push(`Resolved: **${m.title}** (confidence: ${m.confidence.toFixed(2)})`);
        lines.push(`Path: ${m.path}`);
        lines.push(`Type: ${m.type} | Match: ${m.matchReason}`);
        if (m.aliases.length > 0) {
          lines.push(`Aliases: ${m.aliases.join(", ")}`);
        }
        lines.push(`\n${m.excerpt}`);
      } else {
        lines.push(`No confident match found for "${params["name"] as string}".`);
        if (result.candidates.length > 0) {
          lines.push("\nTop candidates:");
          for (const c of result.candidates) {
            lines.push(`  - ${c.title} (${c.path}) — confidence ${c.confidence.toFixed(2)}, match: ${c.matchReason}`);
          }
        }
      }

      lines.push(`\nResolved in ${result.queryTimeMs}ms`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "gbrain_graph",
    description:
      "Traverse entity relationships in the knowledge brain. " +
      "Returns the center entity plus its connected pages with relationship types. " +
      "Use to explore who/what a person or company is connected to.",
    parameters: Type.Object({
      entity: Type.String({
        description: "Entity name or path to start from (e.g. 'Pedro', 'companies/brex.md')",
      }),
      relationship: Type.Optional(
        Type.Union([
          Type.Literal("mentions"),
          Type.Literal("mentioned_by"),
          Type.Literal("co_occurs"),
          Type.Literal("all"),
        ], { default: "all", description: "Which direction of edges to follow" })
      ),
      depth: Type.Optional(
        Type.Number({ default: 1, minimum: 1, maximum: 3, description: "Traversal depth (1-3)" })
      ),
    }),
    async execute(_id, params) {
      const result = executeGraph(
        {
          entity: params["entity"] as string,
          relationship: params["relationship"] as "mentions" | "mentioned_by" | "co_occurs" | "all" | undefined,
          depth: params["depth"] as number | undefined,
        },
        store
      );

      const lines: string[] = [];

      if (!result.center) {
        lines.push(`No entity found matching "${params["entity"] as string}".`);
      } else {
        const c = result.center;
        lines.push(`## ${c.title} (${c.type})`);
        lines.push(`Path: ${c.path}`);
        lines.push(`\nFound ${result.edges.length} edges in ${result.queryTimeMs}ms\n`);

        const byDepth = new Map<number, typeof result.edges>();
        for (const e of result.edges) {
          const arr = byDepth.get(e.depth) ?? [];
          arr.push(e);
          byDepth.set(e.depth, arr);
        }

        for (const [depth, edges] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
          lines.push(`### Depth ${depth}`);
          for (const e of edges) {
            lines.push(`- **${e.title}** (${e.type}) [${e.relationship}] — ${e.path}`);
            if (e.context) lines.push(`  > ${e.context}`);
          }
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "gbrain_timeline",
    description:
      "Query temporal changes across the brain. Shows which pages changed when and why. " +
      "Supports relative dates like '7d', '30d', 'this week', or ISO dates.",
    parameters: Type.Object({
      since: Type.String({
        description: "Start date: ISO date, '7d', '30d', or 'this week'",
      }),
      until: Type.Optional(
        Type.String({ description: "End date (ISO date). Defaults to now." })
      ),
      entity: Type.Optional(
        Type.String({ description: "Filter to a specific entity and its related pages" })
      ),
      scope: Type.Optional(
        Type.String({ description: "Filter by directory prefix (e.g. 'companies', 'people')" })
      ),
    }),
    async execute(_id, params) {
      const result = executeTimeline(
        {
          since: params["since"] as string,
          until: params["until"] as string | undefined,
          entity: params["entity"] as string | undefined,
          scope: params["scope"] as string | undefined,
        },
        store,
        config.brainPath
      );

      const lines: string[] = [];
      lines.push(`Found ${result.entries.length} changes (${result.queryTimeMs}ms)\n`);

      for (const e of result.entries) {
        lines.push(`## ${e.title} [${e.changeType}]`);
        lines.push(`Path: ${e.path} | Type: ${e.type}`);
        lines.push(`Date: ${e.date}`);
        lines.push(`Commit: ${e.commitMessage}`);
        if (e.timelineExcerpt) {
          lines.push(`\n${e.timelineExcerpt}`);
        }
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "gbrain_ingest",
    description:
      "Create or update a brain page with automatic re-indexing. " +
      "Can create new pages, prepend timeline entries, or replace compiled truth sections.",
    parameters: Type.Object({
      path: Type.String({
        description: "Brain-relative path (e.g. 'people/new-person.md')",
      }),
      content: Type.Optional(
        Type.String({ description: "Full page content for new pages" })
      ),
      timelineEntry: Type.Optional(
        Type.String({ description: "Text to prepend as a new timeline entry (date is added automatically)" })
      ),
      compiledTruthUpdate: Type.Optional(
        Type.String({ description: "New compiled truth body (replaces everything above the --- separator)" })
      ),
    }),
    async execute(_id, params) {
      const result = await executeIngest(
        {
          path: params["path"] as string,
          content: params["content"] as string | undefined,
          timelineEntry: params["timelineEntry"] as string | undefined,
          compiledTruthUpdate: params["compiledTruthUpdate"] as string | undefined,
        },
        store,
        config,
        apiKey
      );

      const lines: string[] = [];
      lines.push(`Action: ${result.action}`);
      lines.push(`Path: ${result.path}`);
      lines.push(`Index: ${result.indexStatus}`);
      if (result.errorMessage) {
        lines.push(`Error: ${result.errorMessage}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "gbrain_contradictions",
    description:
      "Scan brain pages for contradictory numeric facts (e.g. conflicting ARR, headcount, funding figures). " +
      "Compares compiled truth against timeline entries to surface disagreements.",
    parameters: Type.Object({
      entity: Type.Optional(
        Type.String({ description: "Check a specific entity only" })
      ),
      scope: Type.Optional(
        Type.String({ description: "Check a specific directory (e.g. 'companies')" })
      ),
      limit: Type.Optional(
        Type.Number({ default: 10, minimum: 1, maximum: 50 })
      ),
    }),
    async execute(_id, params) {
      const result = executeContradictions(
        {
          entity: params["entity"] as string | undefined,
          scope: params["scope"] as string | undefined,
          limit: params["limit"] as number | undefined,
        },
        store
      );

      const lines: string[] = [];
      lines.push(
        `Found ${result.contradictions.length} contradiction(s) across ${result.pagesChecked} pages (${result.queryTimeMs}ms)\n`
      );

      for (const c of result.contradictions) {
        lines.push(`## ${c.pagePath} — ${c.field} [${c.severity}]`);
        lines.push(`  "${c.value1}" from ${c.source1}`);
        lines.push(`  "${c.value2}" from ${c.source2}`);
        lines.push("");
      }

      if (result.contradictions.length === 0) {
        lines.push("No contradictions detected.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "gbrain_confidence",
    description:
      "Score the confidence of factual claims in a brain page's compiled truth section. " +
      "Checks corroboration count, source recency, and agreement across timeline entries.",
    parameters: Type.Object({
      entity: Type.String({
        description: "Entity to score (e.g. 'Brex', 'Pedro')",
      }),
    }),
    async execute(_id, params) {
      const result = executeConfidence(
        { entity: params["entity"] as string },
        store
      );

      const lines: string[] = [];

      if (!result.path) {
        lines.push(`No entity found matching "${params["entity"] as string}".`);
      } else {
        lines.push(`## ${result.entity}`);
        lines.push(`Path: ${result.path}`);
        lines.push(`\nScored ${result.claims.length} factual claims (${result.queryTimeMs}ms)\n`);

        for (const claim of result.claims) {
          const icon = claim.confidence === "high" ? "✓" : claim.confidence === "medium" ? "~" : "?";
          lines.push(`${icon} [${claim.confidence.toUpperCase()}] ${claim.claim}`);
          lines.push(`  Sources: ${claim.sources.join(", ")}`);
          lines.push(`  Note: ${claim.note}`);
          if (claim.lastVerified) lines.push(`  Last verified: ${claim.lastVerified}`);
          lines.push("");
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // ── CLI ───────────────────────────────────────────────────────────────────

  api.registerCli(registerCli(store, config));

  // ── Background Service ────────────────────────────────────────────────────

  api.registerService(createWatcherService());
});

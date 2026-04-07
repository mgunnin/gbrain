import type { GBrainStore, GraphEdgeRow } from "../indexer/store.js";

export interface GraphParams {
  entity: string;
  relationship?: "mentions" | "mentioned_by" | "co_occurs" | "all";
  depth?: number;
}

export interface GraphNode {
  path: string;
  title: string;
  type: string;
}

export interface GraphEdge {
  path: string;
  title: string;
  type: string;
  relationship: string;
  context: string;
  depth: number;
}

export interface GraphResult {
  center: GraphNode | null;
  edges: GraphEdge[];
  queryTimeMs: number;
}

function fetchEdgesForPage(
  pageId: number,
  relationship: "mentions" | "mentioned_by" | "co_occurs" | "all",
  store: GBrainStore
): GraphEdgeRow[] {
  switch (relationship) {
    case "mentions":
      return store.getEdgesFrom(pageId);
    case "mentioned_by":
      return store.getEdgesTo(pageId);
    case "co_occurs":
      return store.getCoOccurs(pageId);
    case "all":
      return [
        ...store.getEdgesFrom(pageId),
        ...store.getEdgesTo(pageId),
        ...store.getCoOccurs(pageId),
      ];
  }
}

export function executeGraph(params: GraphParams, store: GBrainStore): GraphResult {
  const startMs = Date.now();
  const { entity, relationship = "all", depth: maxDepth = 1 } = params;
  const clampedDepth = Math.min(Math.max(maxDepth, 1), 3);

  // Resolve entity to a page
  const textMatches = store.searchByName(entity);
  const firstMatch = textMatches[0];
  if (!firstMatch) {
    return { center: null, edges: [], queryTimeMs: Date.now() - startMs };
  }

  const centerPage = firstMatch.page;
  const center: GraphNode = {
    path: centerPage.path,
    title: centerPage.title,
    type: centerPage.type,
  };

  const allEdges: GraphEdge[] = [];
  // Track visited page IDs and edge keys to avoid duplicates
  const visitedPageIds = new Set<number>([centerPage.id]);
  const seenEdgeKeys = new Set<string>();
  let frontier: number[] = [centerPage.id];

  for (let d = 1; d <= clampedDepth; d++) {
    const nextFrontier: number[] = [];

    for (const pageId of frontier) {
      const rawEdges = fetchEdgesForPage(pageId, relationship, store);
      for (const raw of rawEdges) {
        const edgeKey = `${raw.path}::${raw.relationship}`;
        if (seenEdgeKeys.has(edgeKey)) continue;
        seenEdgeKeys.add(edgeKey);

        allEdges.push({
          path: raw.path,
          title: raw.title,
          type: raw.type,
          relationship: raw.relationship,
          context: raw.context,
          depth: d,
        });

        if (!visitedPageIds.has(raw.neighborPageId)) {
          visitedPageIds.add(raw.neighborPageId);
          nextFrontier.push(raw.neighborPageId);
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return { center, edges: allEdges, queryTimeMs: Date.now() - startMs };
}

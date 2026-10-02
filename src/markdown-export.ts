/**
 * Shared markdown-export machinery: cached object resolution, backlink-closure
 * collection, and bundle building. Used by `notees export markdown` and the
 * `notees shell` `export(ids)` helper — one implementation, both surfaces.
 */

import {
  bundleMarkdown,
  deriveDisplayName,
  type ExportBundle,
  type ExportContext,
  type ExportNode,
} from "@notees/export";

import type { ApiClient } from "./client.js";
import { CliError, EXIT } from "./exit-codes.js";
import { queryString } from "./util.js";

export interface ExportApiObject {
  id: string;
  nodeType: string;
  parentId: string | null;
  classIds: string[];
  name: string | null;
  contentAst?: unknown;
  properties?: { schemaId: string; schemaName: string; value: unknown; metadata?: unknown }[];
}

export interface ApiEdgeRow {
  id: string;
  source_id: string;
  target_id: string | null;
  type: string;
  verb: string | null;
}

interface ApiObjectStub {
  id: string;
  nodeType: string;
  parentId: string | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toExportNode(obj: ExportApiObject): ExportNode {
  const nodeType = (
    obj.nodeType === "page" || obj.nodeType === "class" ? obj.nodeType : "block"
  ) as ExportNode["nodeType"];
  return {
    id: obj.id,
    nodeType,
    name: obj.name ?? null,
    contentAst: Array.isArray(obj.contentAst) ? (obj.contentAst as ExportNode["contentAst"]) : [],
    classIds: Array.isArray(obj.classIds) ? obj.classIds : [],
    properties: (Array.isArray(obj.properties) ? obj.properties : []).map((property) => ({
      schemaId: property.schemaId,
      schemaName: property.schemaName,
      value: property.value,
      ...(isRecord(property.metadata) ? { metadata: property.metadata } : {}),
    })),
  };
}

/** Collect every id export rendering may resolve: mentions, chips, bound verbs, class ids, node-typed property values. */
export function collectReferenceIds(node: ExportNode, into: Set<string>): void {
  for (const classId of node.classIds) into.add(classId);
  for (const property of node.properties) {
    const value = property.value;
    if (isRecord(value) && typeof value.nodeId === "string") into.add(value.nodeId);
  }
  const walk = (tokens: readonly ExportNode["contentAst"][number][]): void => {
    for (const token of tokens) {
      if (token.type === "mention") into.add(token.targetNodeId);
      else if (token.type === "class_chip") into.add(token.classId);
      else if (token.type === "typed_link") {
        if (typeof token.verb === "object") into.add(token.verb.propertySchemaId);
      } else if (token.type === "quote") {
        walk(token.children);
      }
    }
  };
  walk(node.contentAst);
}

export interface ObjectResolver {
  getObject(id: string): Promise<ExportNode | undefined>;
  containingPage(id: string): Promise<ExportNode | undefined>;
}

/**
 * Cached full-object fetch shared by both exporters; parent ids kept on the
 * side for containing-page walks (ExportNode deliberately carries no
 * placement).
 */
export function makeObjectResolver(client: ApiClient): ObjectResolver {
  const objectCache = new Map<string, ExportNode | undefined>();
  const parentOf = new Map<string, string | null>();
  const getObject = async (id: string): Promise<ExportNode | undefined> => {
    if (objectCache.has(id)) return objectCache.get(id);
    let node: ExportNode | undefined;
    try {
      const body = await client.getJson<{ object: ExportApiObject }>(
        `/api/objects/${encodeURIComponent(id)}`,
      );
      parentOf.set(id, body.object.parentId ?? null);
      node = toExportNode(body.object);
    } catch (error) {
      if (error instanceof CliError && error.exitCode === EXIT.domain) node = undefined;
      else throw error;
    }
    objectCache.set(id, node);
    return node;
  };
  const containingPage = async (id: string): Promise<ExportNode | undefined> => {
    let currentId: string | null = id;
    for (let hops = 0; currentId !== null && hops < 64; hops += 1) {
      const node = await getObject(currentId);
      if (node === undefined) return undefined;
      if (node.nodeType === "page") return node;
      if (node.nodeType === "class") return undefined;
      currentId = parentOf.get(currentId) ?? null;
    }
    return undefined;
  };
  return { getObject, containingPage };
}

/**
 * Node set: --ids exports exactly the given set; --linked-to adds the backlink
 * closure (pages only — a block referrer contributes its containing page,
 * which then renders the block inline).
 */
export async function collectClosure(
  client: ApiClient,
  resolver: ObjectResolver,
  options: { ids: string[]; linkedTo?: string | undefined; depth: number },
): Promise<Map<string, ExportNode>> {
  const included = new Map<string, ExportNode>();
  const addSeed = async (id: string): Promise<void> => {
    const node = await resolver.getObject(id);
    if (node === undefined) throw new CliError(EXIT.domain, `object ${id} does not exist`);
    included.set(id, node);
  };
  if (options.linkedTo !== undefined) await addSeed(options.linkedTo);
  for (const id of options.ids) await addSeed(id);

  if (options.linkedTo !== undefined) {
    const seedId = options.linkedTo;
    const visitedSources = new Set<string>(); // edge-source guard (cycle guard)
    const visitedPages = new Set<string>([seedId]);
    let frontier: string[] = [seedId];
    let level = 0;
    while (frontier.length > 0 && level <= options.depth) {
      const next: string[] = [];
      for (const id of frontier) {
        const body = await client.getJson<{ nodeId: string; backlinks: ApiEdgeRow[] }>(
          `/api/objects/${encodeURIComponent(id)}/backlinks`,
        );
        for (const edge of body.backlinks) {
          const sourceId = edge.source_id;
          if (visitedSources.has(sourceId)) continue;
          visitedSources.add(sourceId);
          const source = await resolver.getObject(sourceId);
          if (source === undefined) continue;
          const page = source.nodeType === "page" ? source : await resolver.containingPage(sourceId);
          if (page === undefined || visitedPages.has(page.id)) continue;
          visitedPages.add(page.id);
          included.set(page.id, page);
          next.push(page.id);
        }
      }
      frontier = next;
      level += 1;
    }
  }
  return included;
}

export interface MarkdownBundleSelection {
  ids: string[];
  linkedTo?: string | undefined;
  /** Closure depth: depth N follows N+1 backlink hops (depth 0 = direct referrers); ignored for ids-only exports. */
  depth: number;
}

/**
 * Seeds + closure + children + reference-name resolution → ExportBundle.
 * `notees export markdown` writes/prints it; the shell's `export(ids)` helper
 * returns it as concatenated text.
 */
export async function buildMarkdownBundle(
  client: ApiClient,
  selection: MarkdownBundleSelection,
): Promise<ExportBundle> {
  const resolver = makeObjectResolver(client);
  const included = await collectClosure(client, resolver, {
    ids: selection.ids,
    linkedTo: selection.linkedTo,
    depth: selection.depth,
  });

  // Children map: the object API exposes no children endpoint (M1), so the
  // parent→children map is derived from the paged object list (id-ordered —
  // bullet order is id order, not child-position order; documented deviation),
  // then each child is full-gotten for its contentAst.
  const childrenMap = new Map<string, ExportNode[]>();
  const stubs: ApiObjectStub[] = [];
  let cursor: string | undefined;
  do {
    const query = queryString({ nodeType: "block", limit: 500, cursor });
    const body = await client.getJson<{ objects: ApiObjectStub[]; nextCursor: string | null }>(
      `/api/objects${query}`,
    );
    stubs.push(...body.objects);
    cursor = body.nextCursor ?? undefined;
  } while (cursor !== undefined);
  for (const stub of stubs) {
    if (stub.parentId === null) continue;
    const child = await resolver.getObject(stub.id);
    if (child === undefined) continue;
    const list = childrenMap.get(stub.parentId);
    if (list === undefined) childrenMap.set(stub.parentId, [child]);
    else list.push(child);
  }

  // Pre-resolve every referenced id's current display name (rename-free:
  // mentions render the target's current name, SCHEMA.md Fork 4).
  const referenceIds = new Set<string>();
  for (const node of included.values()) collectReferenceIds(node, referenceIds);
  for (const children of childrenMap.values()) {
    for (const child of children) collectReferenceIds(child, referenceIds);
  }
  const names = new Map<string, string>();
  for (const refId of referenceIds) {
    const node = await resolver.getObject(refId);
    if (node === undefined) continue;
    names.set(refId, deriveDisplayName(node) || node.name?.trim() || refId);
  }

  const exportCtx: ExportContext = {
    nameOf: (id) => names.get(id),
    childrenOf: (id) => childrenMap.get(id) ?? [],
  };
  return bundleMarkdown([...included.values()], exportCtx);
}

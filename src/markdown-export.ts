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

export interface ExportApiObject {
  id: string;
  isClass: boolean;
  presentAsMain: boolean;
  parentId: string | null;
  classIds: string[];
  name: string | null;
  contentAst?: unknown;
  properties?: {
    schemaId: string;
    schemaName: string;
    schemaType?: string;
    value: unknown;
    metadata?: unknown;
  }[];
}

/** The property-schema facts the exporter's per-type branches need. */
export interface SchemaIndexEntry {
  type: string;
  options: Array<{ id: string; label: string }> | null;
}

export type SchemaIndex = ReadonlyMap<string, SchemaIndexEntry>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toExportNode(obj: ExportApiObject, schemaIndex?: SchemaIndex): ExportNode {
  return {
    id: obj.id,
    isClass: obj.isClass ? 1 : 0,
    presentAsMain: obj.presentAsMain ? 1 : 0,
    parentId: obj.parentId ?? null,
    name: obj.name ?? null,
    contentAst: Array.isArray(obj.contentAst) ? (obj.contentAst as ExportNode["contentAst"]) : [],
    classIds: Array.isArray(obj.classIds) ? obj.classIds : [],
    properties: (Array.isArray(obj.properties) ? obj.properties : []).map((property) => ({
      schemaId: property.schemaId,
      schemaName: property.schemaName,
      ...(property.schemaType !== undefined ? { schemaType: property.schemaType } : {}),
      ...(schemaIndex !== undefined
        ? (() => {
            const entry = schemaIndex.get(property.schemaId);
            return entry !== undefined && entry.options !== null && entry.options.length > 0
              ? { schemaOptions: entry.options }
              : {};
          })()
        : {}),
      value: property.value,
      ...(isRecord(property.metadata) ? { metadata: property.metadata } : {}),
    })),
  };
}

/** Fetch the workspace's property schemas once (the per-type export branches
 * need each schema's type + options). */
export async function fetchSchemaIndex(client: ApiClient): Promise<SchemaIndex> {
  const body = await client.getJson<{
    propertySchemas: Array<{ id: string; type: string; options: Array<{ id: string; label: string }> | null }>;
  }>("/api/property-schemas");
  return new Map(body.propertySchemas.map((schema) => [schema.id, { type: schema.type, options: schema.options }]));
}

export interface ApiEdgeRow {
  id: string;
  source_id: string;
  target_id: string | null;
  type: string;
  verb: string | null;
}

/** Document-chrome predicate over the export shape (Revision 11): non-class
 * nodes render as documents when parentless or render-bit set. */
export function rendersAsDocument(
  node: Pick<ExportNode, "isClass" | "presentAsMain" | "parentId">,
): boolean {
  return node.isClass === 0 && (node.parentId === null || node.presentAsMain === 1);
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
 * side for containing-page walks (ExportNode carries placement since
 * Revision 11 — the map stays as the walk's cheap lookup).
 */
export function makeObjectResolver(client: ApiClient, schemaIndex?: SchemaIndex): ObjectResolver {
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
      node = toExportNode(body.object, schemaIndex);
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
      // Classes are never inside a document; the first document-chrome
      // ancestor (parentless or render-bit set) is the containing page.
      if (node.isClass === 1) return undefined;
      if (rendersAsDocument(node)) return node;
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
          const page = rendersAsDocument(source) ? source : await resolver.containingPage(sourceId);
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
  const schemaIndex = await fetchSchemaIndex(client);
  const resolver = makeObjectResolver(client, schemaIndex);
  const included = await collectClosure(client, resolver, {
    ids: selection.ids,
    linkedTo: selection.linkedTo,
    depth: selection.depth,
  });

  // Children map: one position-ordered fetch per node that can appear in the
  // bundle — the included set plus every inline-body descendant discovered
  // below it (the exporter's childrenOf recurses through the map). Only
  // inline-body children (non-class, render bit unset, parented) enter the
  // map: child pages render as their own bundle files, never nested bullets.
  const childrenMap = new Map<string, ExportNode[]>();
  const fetchedChildrenOf = new Set<string>();
  const pending = [...included.keys()];
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (fetchedChildrenOf.has(id)) continue;
    fetchedChildrenOf.add(id);
    let rows: ExportApiObject[];
    try {
      const body = await client.getJson<{ children: ExportApiObject[] }>(
        `/api/objects/${encodeURIComponent(id)}/children`,
      );
      rows = body.children;
    } catch (error) {
      // A node trashed between the closure pass and this fetch exports
      // without children (its subtree is trashed with it) — the scan-era
      // skip for vanished children, now per parent.
      if (error instanceof CliError && error.exitCode === EXIT.domain) continue;
      throw error;
    }
    const inline: ExportNode[] = [];
    for (const child of rows) {
      if (child.parentId === null || child.isClass || child.presentAsMain) continue;
      inline.push(toExportNode(child, schemaIndex));
      pending.push(child.id);
    }
    if (inline.length > 0) childrenMap.set(id, inline);
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

/**
 * Shared JSON-archive export machinery (§34.24 parked row "JSON archive",
 * 2026-10-04): seeds + closure + position-ordered child ids → the
 * `notees-json-archive` envelope via @notees/export. Used by
 * `notees export json`; mirrors markdown-export.ts's selection/resolver
 * reuse so both exporters collect the same node set for identical
 * selectors.
 */

import {
  buildJsonArchive,
  type ExportContext,
  type JsonArchive,
} from "@notees/export";

import type { ApiClient } from "./client.js";
import { CliError, EXIT } from "./exit-codes.js";
import {
  collectClosure,
  fetchSchemaIndex,
  makeObjectResolver,
  toExportNode,
  type ExportApiObject,
} from "./markdown-export.js";

export interface JsonArchiveSelection {
  ids: string[];
  linkedTo?: string | undefined;
  /** Closure depth: depth N follows N+1 backlink hops (depth 0 = direct referrers); ignored for ids-only exports. */
  depth: number;
}

/**
 * Seeds + closure (the markdown bundle's exact selection semantics), then
 * one position-ordered children fetch per included node for the archive's
 * `children` metadata — ALL children ride (main zone + inline body: the
 * archive records the graph slice, it does not file pages the way the
 * markdown bundle does). A node trashed between the closure pass and its
 * children fetch archives with an empty `children` list.
 */
export async function buildJsonArchiveDocument(
  client: ApiClient,
  selection: JsonArchiveSelection,
): Promise<JsonArchive> {
  const schemaIndex = await fetchSchemaIndex(client);
  const resolver = makeObjectResolver(client, schemaIndex);
  const included = await collectClosure(client, resolver, {
    ids: selection.ids,
    linkedTo: selection.linkedTo,
    depth: selection.depth,
  });

  const childrenRows = new Map<string, ExportApiObject[]>();
  for (const id of included.keys()) {
    try {
      const body = await client.getJson<{ children: ExportApiObject[] }>(
        `/api/objects/${encodeURIComponent(id)}/children`,
      );
      // Only the ids enter the archive — the row payloads are mapped so the
      // builder can read them, no matter whether the child itself is in the
      // exported slice (a slice cut above a child still records the id).
      childrenRows.set(id, body.children);
    } catch (error) {
      if (error instanceof CliError && error.exitCode === EXIT.domain) continue;
      throw error;
    }
  }

  const ctx: ExportContext = {
    // The archive keeps ids verbatim — no name resolution pass (the
    // displayName field derives from content, rename-free by construction).
    nameOf: () => undefined,
    childrenOf: (id) =>
      (childrenRows.get(id) ?? []).map((row) => toExportNode(row)),
  };
  return buildJsonArchive([...included.values()], ctx);
}

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, deriveDisplayName } from "@notees/domain";
import { nodeToCsl, sourceClassOf, type CslItem } from "@notees/export";

import type { LocalWorkspace } from "../local-workspace.js";

interface FullObject {
  id: string;
  name: string | null;
  classIds: string[];
  properties?: Array<{ schemaId: string; value: unknown }>;
}

function fullObjectOf(local: LocalWorkspace, id: string): FullObject | undefined {
  try {
    return local.getObject(id).object as unknown as FullObject;
  } catch {
    return undefined;
  }
}

/** Every `{nodeId}` ref carried by a property's rows, in row order. */
function refIdsOf(full: FullObject, schemaId: string): string[] {
  return (full.properties ?? [])
    .filter((p) => p.schemaId === schemaId)
    .flatMap((p) => (Array.isArray(p.value) ? p.value : [p.value]))
    .flatMap((v) =>
      typeof v === "object" && v !== null && typeof (v as { nodeId?: unknown }).nodeId === "string"
        ? [(v as { nodeId: string }).nodeId]
        : [],
    );
}

/**
 * The source node → CSL-JSON projection for the bridge. The mapping itself
 * is @notees/export's nodeToCsl (the same call exportBibtex makes — the
 * export package owns the dual-track authorship read contract and the
 * per-class pool bindings); this module only resolves the caller-side
 * lookups (linkedAuthors agents, publicationDate date refs) against the
 * local store. citekey-less sources ride nodeToCsl's node-id fallback, so
 * they render like any other item. Every source-FAMILY member passes the
 * guard (the roster subclass OR the bare `source` base): a bare-source node
 * reaches nodeToCsl, which types it via the vendor document fallback —
 * matching search's classKey "source" surfacing, so a search hit can never
 * 404 at the citation arm.
 */
export function cslItemFor(local: LocalWorkspace, id: string): CslItem | undefined {
  const full = fullObjectOf(local, id);
  if (full === undefined) return undefined;
  if (sourceClassOf(full.classIds) === undefined && !full.classIds.includes(SYSTEM_CLASS_UUIDS.source)) {
    return undefined;
  }
  const props = full.properties ?? [];

  const agentNames = new Map<string, string>();
  for (const refId of refIdsOf(full, SYSTEM_PROPERTY_UUIDS.linkedAuthors)) {
    const agent = fullObjectOf(local, refId);
    if (agent === undefined) continue; // unresolvable agent contributes nothing
    const display =
      deriveDisplayName(agent as Parameters<typeof deriveDisplayName>[0]) || agent.name?.trim() || "";
    if (display.length > 0) agentNames.set(refId, display);
  }
  const dateNames = new Map<string, string>();
  for (const refId of refIdsOf(full, SYSTEM_PROPERTY_UUIDS.publicationDate)) {
    const ref = fullObjectOf(local, refId);
    if (ref === undefined) continue; // unresolvable date ref contributes nothing
    const display =
      deriveDisplayName(ref as Parameters<typeof deriveDisplayName>[0]) || ref.name?.trim() || "";
    if (display.length > 0) dateNames.set(refId, display);
  }

  return nodeToCsl(
    { id: full.id, name: full.name, classIds: full.classIds },
    props as unknown as Parameters<typeof nodeToCsl>[1],
    {
      resolveName: (refId) => dateNames.get(refId),
      resolveAgentName: (refId) => agentNames.get(refId),
    },
  );
}

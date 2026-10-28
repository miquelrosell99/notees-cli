/**
 * `notees import logseq-db <file.sqlite>` — the Logseq DB (.sqlite) drift
 * reconcile, productized from the owner-approved one-off driver (the
 * /tmp/logseq-drift plan/run rehearsals against a live workspace graph,
 * 2026-10-26). The semantics are ported, not redesigned:
 *
 *   - decode the kvs transit-datom store via @notees/export `decodeKvs` +
 *     `buildLogseqDbModel` (the sqlite itself is read through Node's built-in
 *     `node:sqlite` — no native dependency);
 *   - class mapping by (trimmed, lowercased) name — unmapped titles land in
 *     the report, never the plan;
 *   - the validated property mapping table (PROP_MAP) — select values map
 *     onto options by label; the NEW_SCHEMAS trio is created (global text)
 *     when absent;
 *   - missing nodes → create with the preserved Logseq uuid, contentAst
 *     titles with uuid-resolvable links as mentions, siblings ordered by the
 *     Logseq fractional order, parents resolved against the active target,
 *     the planned set, or the deterministic date chain (creates apply
 *     depth-layered with cycle-breaking);
 *   - title conflicts → `--strategy notees-wins` (default: Notees titles are
 *     never written) or `newer-wins` (the Logseq title is written only when
 *     `:block/updated-at` is strictly newer than the Notees updatedAt);
 *   - properties → fills for missing values (always), restores for differing
 *     values (only under `--restore-diffs` — restores clobber); extends-aware
 *     scope eligibility BOTH directions, extends-aware target-class-filter
 *     validation, dangling-ref / single-value-cap report entries;
 *   - trashed (inactive) target nodes reserve their id: skipped + reported
 *     (Notees wins on trashed);
 *   - idempotent: every write re-checks current state, and a re-run plans
 *     nothing.
 *
 * Dry-run is the default: the full plan report prints and nothing is
 * written; `--write` (or `--yes`, the destructive-confirm alias) applies it.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import {
  SYSTEM_CLASS_UUIDS,
  chainNodeIds,
  dateNodeLabel,
  parseIsoDate,
} from "@notees/domain";
import {
  buildLogseqDbModel,
  decodeKvs,
  type KvsRow,
  type LqNode,
  type LogseqDbModel,
} from "@notees/export";

import type { ApiClient } from "./client.js";
import type { CliIo } from "./cli.js";
import { CliError, EXIT } from "./exit-codes.js";
import { uuidv7 } from "./uuid.js";

/** The validated Logseq → Notees property mapping (owner-approved 2026-10-26). */
const PROP_MAP: Record<string, string> = {
  "Autor": "Linked authors",
  "Título original": "Título original",
  "Sexo": "Sexo",
  "Link": "Link",
  "Consumido": "Consumido",
  "Última consulta": "Última consulta",
  "Cliente": "Cliente",
  "Consumiendo": "Consumiendo",
  "Fecha": "Fecha",
  "Email": "Email",
  "Valoración": "Valoración",
  "Teléfono": "Teléfono",
  "Tipo de estudio": "Tipo de estudio",
  "nif": "NIF",
  "domicilio social": "domicilio social",
  "Objetivo": "Objetivo",
  "Relacionado": "Relacionado",
};
/** Schemas the planner may create (global text) when absent from the target. */
const NEW_SCHEMAS = ["domicilio social", "Objetivo", "Relacionado"];

export type TitleStrategy = "notees-wins" | "newer-wins";

export interface LogseqDbImportOptions {
  client: ApiClient;
  io: CliIo;
  json: boolean;
  file: string;
  /** false = dry run: print the report, write nothing (the default). */
  write: boolean;
  strategy: TitleStrategy;
  restoreDiffs: boolean;
}

// --- target-state shapes (the object API rows this planner reads) ------------

interface TargetObjectRow {
  id: string;
  name: string | null;
  classIds: string[];
  updatedAt?: string | null;
}

interface TargetClassRow {
  id: string;
  name: string;
  parentClassIds: string[];
}

interface TargetSchemaRow {
  id: string;
  name: string;
  type: string;
  multi: boolean;
  options: Array<{ id: string; label: string }> | null;
  scopeClassIds: string[] | null;
  targetClassFilter: string[] | null;
}

interface HolderProperty {
  schemaId: string;
  schemaName: string;
  value: unknown;
}

interface ContentToken {
  type: "text";
  text: string;
}

interface MentionToken {
  type: "mention";
  targetNodeId: string;
}

type TitleToken = ContentToken | MentionToken;

interface CreateOp {
  id: string;
  parentId: string | null;
  isEmbedded: boolean;
  contentAst: TitleToken[];
  classIds: string[];
}

interface TitleUpdateOp {
  id: string;
  contentAst: TitleToken[];
  lqUp: number;
  nqUp: number;
}

interface PropOp {
  nodeId: string;
  schemaId: string;
  schemaName: string;
  values: unknown[];
}

interface PropRestoreOp extends PropOp {
  from: string[];
  to: string[];
}

interface PropFailure {
  nodeId?: string;
  schema: string;
  reason: string;
  dropped?: string;
}

interface SchemaCreateOp {
  name: string;
  type: string;
}

interface PlanReport {
  workspace: string | null;
  targetNodes: number;
  export: { nodes: number; matched: number; missing: number; skipped: LogseqDbModel["skipped"] };
  classes: { mapped: number; unmapped: Record<string, number> };
  properties: { mapped: number; unmapped: string[]; newSchemas: string[] };
  plan: {
    schemaCreates: number;
    extraValuesDropped: number;
    chainCreates: number;
    creates: number;
    titleUpdates: number;
    titleKeepNotees: number;
    propFills: number;
    propRestores: number;
    propFailures: number;
  };
  createWarnings: number;
  /** Additive: trashed (inactive) target nodes skipped — their id is taken. */
  trashedSkipped: number;
  /** Additive: dry-run/write mode + strategy actually used. */
  dryRun: boolean;
  strategy: TitleStrategy;
  restoreDiffs: boolean;
  samples: {
    titleUpdates: Array<{ id: string; notees: string | null; lqUp: number; nqUp: number }>;
    propRestores: Array<{ nodeId: string; schema: string; from: string[]; to: string[] }>;
    createWarnings: string[];
  };
  /** Additive: the full op lists (the reference plan.json payload). */
  ops: {
    schemaCreates: SchemaCreateOp[];
    chainCreates: CreateOp[];
    creates: CreateOp[];
    titleUpdates: TitleUpdateOp[];
    propFills: PropOp[];
    propRestores: PropRestoreOp[];
    propFailures: PropFailure[];
  };
  /** Additive: set only after a write run — execution failures, if any. */
  executionFailures?: Array<{ kind: string; id: string; error: string }>;
}

// --- sqlite reading ------------------------------------------------------------

/**
 * The sqlite is read through Node's built-in `node:sqlite` (DatabaseSync,
 * readonly). Rationale: better-sqlite3 is a native module and must not
 * become a CLI dependency; sql.js would drag a wasm payload plus a
 * locateFile dance into the bundle; node:sqlite ships in the runtime (Node
 * ≥ 22.13 without a flag — older 22.x needs --experimental-sqlite, diagnosed
 * below) and handles the 76 MB-class exports fine. The module is loaded
 * lazily via createRequire: importing the CLI must keep working on a runtime
 * that predates node:sqlite — only this command needs it (and vite's
 * resolver predates the builtin, so a static import would not transform
 * under vitest either).
 */
type NodeSqlite = typeof import("node:sqlite");

function loadNodeSqlite(): NodeSqlite {
  try {
    return createRequire(import.meta.url)("node:sqlite") as NodeSqlite;
  } catch (error) {
    throw new CliError(
      EXIT.usage,
      `import logseq-db reads the sqlite through node:sqlite, which needs Node ≥ 22.13 (older 22.x: run node --experimental-sqlite) (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function readKvsRows(file: string): KvsRow[] {
  if (!existsSync(file)) {
    throw new CliError(EXIT.usage, `cannot import ${file}: file not found`);
  }
  const { DatabaseSync } = loadNodeSqlite();
  let db: InstanceType<NodeSqlite["DatabaseSync"]>;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw new CliError(
      EXIT.usage,
      `cannot import ${file}: node:sqlite could not open it (${error instanceof Error ? error.message : String(error)}) — import logseq-db needs Node ≥ 22.13 (older 22.x: run node --experimental-sqlite)`,
    );
  }
  try {
    const rows = db.prepare("SELECT addr, content FROM kvs").all() as Array<{
      addr: number;
      content: string | Buffer;
    }>;
    return rows.map((row) => ({
      addr: row.addr,
      content: typeof row.content === "string" ? row.content : row.content.toString("utf8"),
    }));
  } catch (error) {
    throw new CliError(
      EXIT.domain,
      `cannot import ${file}: no readable kvs table (${error instanceof Error ? error.message : String(error)}) — is this a Logseq DB export?`,
    );
  } finally {
    try {
      db.close();
    } catch {
      // The read already finished; a close failure must not mask the result.
    }
  }
}

// --- title flattening with mentions --------------------------------------------

const LINK_RE = /(\#?\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]|\[([^\]]*)\]\(\[\[([0-9a-f-]{36})\]\]\)|\(\(([0-9a-f-]{36})\)\))/gi;

function titleToAst(title: string, nodeUuids: Set<string>): TitleToken[] {
  const out: TitleToken[] = [];
  let last = 0;
  for (const m of title.matchAll(LINK_RE)) {
    if (m.index > last) out.push({ type: "text", text: title.slice(last, m.index) });
    const target = (m[2] ?? m[4] ?? m[5]) as string;
    if (nodeUuids.has(target.toLowerCase())) {
      out.push({ type: "mention", targetNodeId: target.toLowerCase() });
    } else {
      const label = m[3] ?? m[0];
      out.push({ type: "text", text: label });
    }
    last = m.index + m[0].length;
  }
  if (last < title.length) out.push({ type: "text", text: title.slice(last) });
  return out.length === 0 ? [{ type: "text", text: "" }] : out;
}

// --- value canon (compare Logseq-incoming vs Notees-current) ---------------------

const mdnorm = (s: unknown): string =>
  String(s).replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)").trim().toLowerCase();

// --- create ordering (ported from the reference executor) ------------------------

/** Logseq data can contain parent cycles; cycle members land at root (no move
 * op exists to attach them afterwards). Returns the broken member ids. */
function breakCycles<T extends { id: string; parentId: string | null }>(unique: T[], byId: Map<string, T>): string[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const broken: string[] = [];
  const visit = (id: string, stack: string[]): void => {
    color.set(id, GRAY);
    stack.push(id);
    const c = byId.get(id);
    const p = c?.parentId ? byId.get(c.parentId) : null;
    if (p) {
      const pc = color.get(p.id) ?? WHITE;
      if (pc === GRAY) {
        // Back edge — break: every node from p.id onwards rides at root.
        const idx = stack.indexOf(p.id);
        for (const m of stack.slice(idx)) {
          const member = byId.get(m);
          if (member?.parentId) {
            member.parentId = null;
            broken.push(m);
          }
        }
      } else if (pc === WHITE) {
        visit(p.id, stack);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const c of unique) {
    if ((color.get(c.id) ?? WHITE) === WHITE) visit(c.id, []);
  }
  return broken;
}

/**
 * Depth-layered chunks: a node may only share a chunk with nodes of the same
 * depth, so bounded intra-batch parallelism can never race a parent (every
 * parent sits in an earlier layer).
 */
function createChunks<T extends { id: string; parentId: string | null }>(creates: T[], chunkSize = 400): T[][] {
  const unique = [...new Map(creates.map((c) => [c.id, c])).values()];
  const byId = new Map(unique.map((c) => [c.id, c]));
  breakCycles(unique, byId);
  const depthMemo = new Map<string, number>();
  const depthOf = (c: T, guard = new Set<string>()): number => {
    const memo = depthMemo.get(c.id);
    if (memo !== undefined) return memo;
    if (guard.has(c.id)) return 0;
    guard.add(c.id);
    const p = c.parentId ? byId.get(c.parentId) : null;
    const d = p ? depthOf(p, guard) + 1 : 0;
    depthMemo.set(c.id, d);
    return d;
  };
  const byDepth = new Map<number, T[]>();
  for (const c of unique) {
    const d = depthOf(c);
    const layer = byDepth.get(d);
    if (layer !== undefined) layer.push(c);
    else byDepth.set(d, [c]);
  }
  const chunks: T[][] = [];
  for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
    const layer = byDepth.get(d) as T[];
    for (let i = 0; i < layer.length; i += chunkSize) chunks.push(layer.slice(i, i + chunkSize));
  }
  return chunks;
}

// --- the command ------------------------------------------------------------------

export async function runLogseqDbImport(options: LogseqDbImportOptions): Promise<void> {
  const { client, io, json, write, strategy, restoreDiffs } = options;
  const progress = (m: Record<string, unknown>): void => {
    io.stderr.write(`${JSON.stringify({ t: Date.now(), ...m })}\n`);
  };
  const emit = (human: string, machine: unknown): void => {
    if (json) io.stdout.write(`${JSON.stringify(machine, null, 2)}\n`);
    else io.stdout.write(human);
  };

  // --- decode the export -------------------------------------------------------
  const rows = readKvsRows(options.file);
  const entities = decodeKvs(rows);
  const model = buildLogseqDbModel(entities);
  // uuid → Logseq updated-at (ms) for the newer-wins rule.
  const lqUpdatedByUuid = new Map<string, number>();
  for (const o of entities.values()) {
    const u = o[":block/uuid"];
    const up = o[":block/updated-at"];
    if (typeof u === "string" && typeof up === "number") lqUpdatedByUuid.set(u, up);
  }

  // --- target workspace state ----------------------------------------------------
  progress({ op: "target.read", note: "listing target workspace" });
  const targetObjects = await listAllObjects(client, false);
  const inactiveObjects = await listAllObjects(client, true);
  // Active rows drive parent resolution, dangling-ref checks and title
  // comparisons; trashed rows only reserve their id (a create against one
  // would 409 — Notees wins on trashed).
  const targetById = new Map(targetObjects.map((o) => [o.id, o]));
  const inactiveIds = new Set(inactiveObjects.map((o) => o.id));
  const existingIds = new Set([...targetById.keys(), ...inactiveIds]);
  const { classes } = await client.getJson<{ classes: TargetClassRow[] }>("/api/classes");
  const classByName = new Map(classes.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const { propertySchemas } = await client.getJson<{ propertySchemas: TargetSchemaRow[] }>(
    "/api/property-schemas",
  );
  const schemaByName = new Map(propertySchemas.map((s) => [s.name, s]));
  const schemaNames = new Set(propertySchemas.map((s) => s.name));
  const workspace = await client.workspaceId().catch(() => undefined);

  // --- class mapping ---------------------------------------------------------------
  const classMap = new Map<string, string>(); // logseq title → notees class id
  const unmappedClasses = new Map<string, number>();
  const mapClassTitle = (t: string): void => {
    if (classMap.has(t) || unmappedClasses.has(t)) return;
    const hit = classByName.get(t.trim().toLowerCase());
    if (hit) classMap.set(t, hit);
    else unmappedClasses.set(t, (unmappedClasses.get(t) ?? 0) + 1);
  };
  for (const c of model.classes) mapClassTitle(c.title);
  for (const n of model.nodes) for (const t of n.classTitles) mapClassTitle(t);

  // --- property mapping --------------------------------------------------------------
  const schemaPlan: SchemaCreateOp[] = [];
  const propTargets = new Map<string, TargetSchemaRow>();
  for (const p of model.properties) {
    const targetName = PROP_MAP[p.title];
    if (targetName === undefined) continue;
    let schema = schemaByName.get(targetName);
    if (schema === undefined && NEW_SCHEMAS.includes(targetName)) {
      schemaPlan.push({ name: targetName, type: "text" });
      schema = {
        id: `new:${targetName}`,
        name: targetName,
        type: "text",
        multi: false,
        options: [],
        scopeClassIds: null,
        targetClassFilter: null,
      };
    }
    if (schema !== undefined) propTargets.set(p.title, schema);
  }
  const unmappedProps = model.properties.filter((p) => !propTargets.has(p.title)).map((p) => p.title);

  // --- node classification ---------------------------------------------------------
  const allLqUuids = new Set(model.nodes.map((n) => n.uuid));
  const matched = model.nodes.filter((n) => targetById.has(n.uuid));
  const trashed = model.nodes.filter((n) => !targetById.has(n.uuid) && inactiveIds.has(n.uuid));
  const missing = model.nodes.filter((n) => !targetById.has(n.uuid) && !inactiveIds.has(n.uuid));

  // --- creates ------------------------------------------------------------------------
  const dateDays = new Set<string>();
  const plannedIds = new Set(missing.map((n) => n.uuid));
  const createWarnings: string[] = [];
  const resolveParent = (n: LqNode): { parentId: string | null; warning?: string } => {
    const p = n.parentUuid;
    if (p === null) return { parentId: null };
    if (targetById.has(p) || plannedIds.has(p)) return { parentId: p };
    const day = model.dateByUuid.get(p);
    if (day !== undefined) {
      dateDays.add(day);
      return { parentId: chainNodeIds(isoDay(day)).day };
    }
    return { parentId: null, warning: `parent ${p} missing for ${n.uuid}` };
  };
  const creates: CreateOp[] = [];
  const byParent = new Map<string, LqNode[]>();
  for (const n of missing) {
    const { parentId, warning } = resolveParent(n);
    if (warning !== undefined) createWarnings.push(warning);
    const key = parentId ?? "__root__";
    const group = byParent.get(key);
    if (group !== undefined) group.push(n);
    else byParent.set(key, [n]);
  }
  for (const [parentId, group] of byParent) {
    group.sort((a, b) => String(a.order ?? "").localeCompare(String(b.order ?? "")));
    for (const n of group) {
      const cls = n.classTitles.map((t) => classMap.get(t)).filter((id): id is string => id !== undefined);
      creates.push({
        id: n.uuid,
        parentId: parentId === "__root__" ? null : parentId,
        isEmbedded: parentId !== "__root__" && parentId !== null,
        contentAst: titleToAst(n.title ?? n.name ?? "", allLqUuids),
        classIds: cls,
      });
    }
  }

  // --- title conflicts ------------------------------------------------------------------
  const titleUpdates: TitleUpdateOp[] = [];
  const titleKeepNotees: string[] = [];
  const normTitle = (s: string): string =>
    s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  for (const n of matched) {
    const lqTitle = n.title ?? n.name ?? "";
    const t = targetById.get(n.uuid);
    if (t === undefined) continue;
    const noteesTitle = t.name ?? "";
    if (normTitle(lqTitle) === normTitle(noteesTitle)) continue;
    const lqUp = lqUpdatedByUuid.get(n.uuid) ?? 0;
    const nqUp = Date.parse(t.updatedAt ?? "1970-01-01") || 0;
    if (strategy === "newer-wins" && lqUp > nqUp) {
      titleUpdates.push({ id: n.uuid, contentAst: titleToAst(lqTitle, allLqUuids), lqUp, nqUp });
    } else {
      titleKeepNotees.push(n.uuid);
    }
  }

  // --- property ops ------------------------------------------------------------------------
  const holders = matched.filter((n) => n.props.length > 0);
  progress({ op: "target.read", note: `fetching properties for ${holders.length} matched holders` });
  const holderState = new Map<string, { classIds: string[]; properties: HolderProperty[] }>();
  {
    const queue = holders.map((n) => n.uuid);
    await Promise.all(
      Array.from({ length: Math.min(8, Math.max(1, queue.length)) }, async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          const body = await client.getJson<{
            object: { id: string; classIds: string[]; properties?: HolderProperty[] };
          }>(`/api/objects/${encodeURIComponent(id)}`);
          holderState.set(id, {
            classIds: body.object.classIds ?? [],
            properties: body.object.properties ?? [],
          });
        }
      }),
    );
  }

  // Extends-aware scope eligibility BOTH directions: a node class whose own
  // ancestor closure hits the scope/filter set qualifies (subclasses inherit
  // eligibility); the scope/filter set itself includes the scoped/filtered
  // classes' extends-ancestors.
  const ancestorsOf = new Map<string, Set<string>>();
  {
    const byId = new Map(classes.map((c) => [c.id, c]));
    for (const c of classes) {
      const set = new Set<string>();
      const queue = [...(c.parentClassIds ?? [])];
      while (queue.length > 0) {
        const p = queue.shift() as string;
        if (set.has(p)) continue;
        set.add(p);
        const pc = byId.get(p);
        if (pc) queue.push(...(pc.parentClassIds ?? []));
      }
      ancestorsOf.set(c.id, set);
    }
  }
  const closureOf = (ids: string[]): Set<string> => {
    const set = new Set(ids);
    for (const id of ids) for (const a of ancestorsOf.get(id) ?? []) set.add(a);
    return set;
  };
  const extendsAwareHit = (classIds: string[] | undefined, set: Set<string> | null | undefined): boolean => {
    if (set === undefined || set === null) return true;
    for (const c of classIds ?? []) {
      if (set.has(c)) return true;
      for (const a of ancestorsOf.get(c) ?? []) if (set.has(a)) return true;
    }
    return false;
  };
  const schemaScope = new Map<string, Set<string> | null>(); // schema name → eligible class ids | null (global)
  for (const s of propertySchemas) {
    schemaScope.set(s.name, s.scopeClassIds === null || s.scopeClassIds.length === 0 ? null : closureOf(s.scopeClassIds));
  }
  for (const sp of schemaPlan) schemaScope.set(sp.name, null); // planned schemas are global
  const eligibleFor = (schemaName: string, classIds: string[]): boolean =>
    extendsAwareHit(classIds, schemaScope.get(schemaName));

  const targetFilterSets = new Map<string, Set<string> | null>();
  for (const s of propertySchemas) {
    targetFilterSets.set(
      s.name,
      s.targetClassFilter === null || s.targetClassFilter.length === 0 ? null : closureOf(s.targetClassFilter),
    );
  }
  for (const sp of schemaPlan) targetFilterSets.set(sp.name, null);

  const optLabel = new Map<string, string>();
  for (const s of propertySchemas) for (const o of s.options ?? []) optLabel.set(o.id, o.label);
  const schemaMulti = new Map<string, boolean>();
  for (const s of propertySchemas) schemaMulti.set(s.name, s.multi);
  for (const sp of schemaPlan) schemaMulti.set(sp.name, false);

  const canon = (p: HolderProperty): string => {
    const v = p.value;
    const schemaType = schemaByName.get(p.schemaName)?.type;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && "nodeId" in v) {
      const nodeId = (v as { nodeId: string }).nodeId;
      const dayMatch = /00dd-(\d{8})/.exec(nodeId);
      if (schemaType === "datetime" && dayMatch !== null) return `day:${dayMatch[1]}`;
      if (schemaType === "text" || schemaType === "email") {
        // Text values ride node-backed carriers — compare the carried TEXT.
        const name = targetById.get(nodeId)?.name ?? "";
        return `lit:${mdnorm(name)}`;
      }
      return `node:${nodeId}`;
    }
    if (schemaType === "select" || schemaType === "multi_select") {
      const xs = Array.isArray(v) ? v : [v];
      return `sel:${xs.map((x) => (optLabel.get(String(x)) ?? String(x)).toString().toLowerCase()).sort().join("|")}`;
    }
    if (schemaType === "datetime") {
      const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
      return m !== null ? `day:${m[1]}${m[2]}${m[3]}` : `raw:${String(v)}`;
    }
    if (schemaType === "text" || schemaType === "email") {
      return `lit:${mdnorm(v)}`;
    }
    return `lit:${String(v).trim().toLowerCase()}`;
  };

  const missingByUuid = new Map(missing.map((n) => [n.uuid, n]));
  const refClassIds = (uuid: string): string[] | null => {
    if (targetById.has(uuid)) return targetById.get(uuid)?.classIds ?? [];
    const lqn = missingByUuid.get(uuid);
    if (lqn) return lqn.classTitles.map((t) => classMap.get(t)).filter((id): id is string => id !== undefined);
    return null;
  };

  const propFills: PropOp[] = [];
  const propRestores: PropRestoreOp[] = [];
  const propFailures: PropFailure[] = [];
  const propNotes: PropFailure[] = [];

  const capSingle = (schemaName: string, incoming: Array<{ shape: unknown; canon: string }>): Array<{ shape: unknown; canon: string }> => {
    if (schemaMulti.get(schemaName) === true || incoming.length <= 1) return incoming;
    for (const extra of incoming.slice(1)) {
      propNotes.push({ schema: schemaName, reason: "extra-values-dropped", dropped: extra.canon });
    }
    return incoming.slice(0, 1);
  };

  const filterIncoming = (
    n: LqNode,
    schema: { name: string },
    incoming: Array<{ shape: unknown; canon: string; uuid?: string } | null>,
  ): Array<{ shape: unknown; canon: string; uuid?: string }> =>
    incoming.filter((i): i is { shape: unknown; canon: string; uuid?: string } => {
      if (i === null) return false;
      if (i.uuid !== undefined && !targetById.has(i.uuid) && !allLqUuids.has(i.uuid)) {
        propFailures.push({ nodeId: n.uuid, schema: schema.name, reason: `dangling-ref:${i.uuid}` });
        return false;
      }
      if (i.uuid !== undefined) {
        const filter = targetFilterSets.get(schema.name);
        if (filter !== undefined && filter !== null) {
          const refClasses = refClassIds(i.uuid) ?? [];
          if (refClasses.length > 0 && !extendsAwareHit(refClasses, filter)) {
            propFailures.push({ nodeId: n.uuid, schema: schema.name, reason: `target-class-mismatch:${i.uuid}` });
            return false;
          }
        }
      }
      return true;
    });

  const buildIncoming = (
    n: LqNode,
    prop: LqNode["props"][number],
    schema: { name: string; type: string; options: Array<{ id: string; label: string }> | null },
  ): Array<{ shape: unknown; canon: string; uuid?: string }> =>
    filterIncoming(
      n,
      schema,
      prop.values.map((v) => {
        if (v.kind === "node") return { shape: { nodeId: v.uuid }, canon: `node:${v.uuid}`, uuid: v.uuid };
        if (v.kind === "date") {
          dateDays.add(v.day);
          return { shape: { nodeId: chainNodeIds(isoDay(v.day)).day }, canon: `day:${v.day}` };
        }
        if (v.kind === "boolean") return { shape: v.value, canon: `lit:${v.value}` };
        if (v.kind === "number") return { shape: v.value, canon: `lit:${v.value}` };
        if (schema.type === "select" || schema.type === "multi_select") {
          // Logseq closed values arrive as text — map onto the option by label.
          const opt = (schema.options ?? []).find(
            (o) => o.label.trim().toLowerCase() === v.text.trim().toLowerCase(),
          );
          if (opt === undefined) {
            propFailures.push({ nodeId: n.uuid, schema: schema.name, reason: `unknown-option:${v.text}` });
            return null;
          }
          return { shape: opt.id, canon: `sel:${opt.label.toLowerCase()}` };
        }
        return { shape: v.text, canon: `lit:${mdnorm(v.text)}` };
      }),
    );

  // Matched holders: fill missing values; differing values are restores
  // (planned always — counted — but only applied under --restore-diffs).
  for (const n of holders) {
    const st = holderState.get(n.uuid);
    if (st === undefined) continue;
    const existing = new Map<string, string[]>();
    for (const p of st.properties) {
      const list = existing.get(p.schemaName);
      if (list !== undefined) list.push(canon(p));
      else existing.set(p.schemaName, [canon(p)]);
    }
    for (const prop of n.props) {
      const schema = propTargets.get(prop.title);
      if (schema === undefined) continue;
      if (!eligibleFor(schema.name, st.classIds)) {
        propFailures.push({ nodeId: n.uuid, schema: schema.name, reason: "ineligible-scope" });
        continue;
      }
      const incoming = capSingle(schema.name, buildIncoming(n, prop, schema));
      if (incoming.length === 0) continue;
      const curS = [...(existing.get(schema.name) ?? [])].sort();
      const incS = incoming.map((i) => i.canon).sort();
      if (curS.length === 0) {
        propFills.push({ nodeId: n.uuid, schemaId: schema.id, schemaName: schema.name, values: incoming.map((i) => i.shape) });
      } else if (JSON.stringify(curS) !== JSON.stringify(incS)) {
        propRestores.push({
          nodeId: n.uuid,
          schemaId: schema.id,
          schemaName: schema.name,
          from: curS,
          to: incS,
          values: incoming.map((i) => i.shape),
        });
      }
    }
  }

  // Property fills for MISSING nodes (their values can't exist yet).
  for (const n of missing) {
    if (n.props.length === 0) continue;
    const plannedClassIds = n.classTitles
      .map((t) => classMap.get(t))
      .filter((id): id is string => id !== undefined);
    for (const prop of n.props) {
      const schema = propTargets.get(prop.title);
      if (schema === undefined) continue;
      if (!eligibleFor(schema.name, plannedClassIds)) {
        propFailures.push({ nodeId: n.uuid, schema: schema.name, reason: "ineligible-scope" });
        continue;
      }
      // buildIncoming (not the matched arm's inline copy): select values map
      // onto options by label here too — the reference's missing arm wrote raw
      // text and would have failed loud against the select schema.
      const incoming = capSingle(schema.name, buildIncoming(n, prop, schema));
      if (incoming.length === 0) continue;
      propFills.push({ nodeId: n.uuid, schemaId: schema.id, schemaName: schema.name, values: incoming.map((i) => i.shape) });
    }
  }

  // --- date chains ---------------------------------------------------------------------------
  const chainCreates: CreateOp[] = [];
  for (const day of [...dateDays].sort()) {
    const ids = chainNodeIds(isoDay(day));
    const parts = parseIsoDate(isoDay(day));
    const chain = [
      { id: ids.year, name: dateNodeLabel(parts, "year"), parentId: null as string | null, classId: SYSTEM_CLASS_UUIDS.year },
      { id: ids.month, name: dateNodeLabel(parts, "month"), parentId: ids.year, classId: SYSTEM_CLASS_UUIDS.month },
      { id: ids.day, name: dateNodeLabel(parts, "day"), parentId: ids.month, classId: SYSTEM_CLASS_UUIDS.day },
    ];
    for (const node of chain) {
      if (!existingIds.has(node.id) && !plannedIds.has(node.id)) {
        plannedIds.add(node.id);
        chainCreates.push({
          id: node.id,
          parentId: node.parentId,
          isEmbedded: false,
          contentAst: [{ type: "text", text: node.name }],
          classIds: [node.classId],
        });
      }
    }
  }

  const allPropFailures = [...propFailures, ...propNotes];
  const report: PlanReport = {
    workspace: workspace ?? null,
    targetNodes: targetObjects.length,
    export: { nodes: model.nodes.length, matched: matched.length, missing: missing.length, skipped: model.skipped },
    classes: {
      mapped: classMap.size,
      unmapped: Object.fromEntries([...unmappedClasses.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
    properties: {
      mapped: propTargets.size,
      unmapped: unmappedProps,
      newSchemas: schemaPlan.map((s) => s.name),
    },
    plan: {
      schemaCreates: schemaPlan.length,
      extraValuesDropped: propNotes.length,
      chainCreates: chainCreates.length,
      creates: creates.length,
      titleUpdates: titleUpdates.length,
      titleKeepNotees: titleKeepNotees.length,
      propFills: propFills.length,
      propRestores: propRestores.length,
      propFailures: allPropFailures.length,
    },
    createWarnings: createWarnings.length,
    trashedSkipped: trashed.length,
    dryRun: !write,
    strategy,
    restoreDiffs,
    samples: {
      titleUpdates: titleUpdates.slice(0, 5).map((u) => ({
        id: u.id,
        notees: targetById.get(u.id)?.name ?? null,
        lqUp: u.lqUp,
        nqUp: u.nqUp,
      })),
      propRestores: propRestores.slice(0, 5).map((r) => ({ nodeId: r.nodeId, schema: r.schemaName, from: r.from, to: r.to })),
      createWarnings: createWarnings.slice(0, 5),
    },
    ops: {
      schemaCreates: schemaPlan,
      chainCreates,
      creates,
      titleUpdates,
      propFills,
      propRestores,
      propFailures: allPropFailures,
    },
  };

  const humanReport = renderHumanReport(report);
  if (!write) {
    emit(
      `${humanReport}\ndry run — nothing was written. Re-run with --write (or --yes) to apply; --json prints the machine report.\n`,
      report,
    );
    return;
  }

  // --- execute ---------------------------------------------------------------------------------
  const executionFailures: Array<{ kind: string; id: string; error: string }> = [];
  const applied = { schemas: 0, chains: 0, creates: 0, titles: 0, fills: 0, restores: 0 };

  // Schema creates first (fills reference them).
  for (const s of schemaPlan) {
    if (schemaNames.has(s.name)) continue;
    try {
      await client.postJson("/api/property-schemas", {
        propertySchemaId: uuidv7(),
        name: s.name,
        type: s.type,
        multi: false,
      });
      schemaNames.add(s.name);
      applied.schemas += 1;
      progress({ op: "schema.create", name: s.name });
    } catch (error) {
      executionFailures.push({ kind: "schema", id: s.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Create nodes depth-layered — chains + content in one ordering, parents
  // always in an earlier layer than their children.
  const createdIds = new Set(existingIds);
  const allCreates = [...chainCreates, ...creates];
  const chunks = createChunks(allCreates);
  let createDone = 0;
  for (const chunk of chunks) {
    const bodies = chunk.filter((c) => !createdIds.has(c.id));
    const skipped = chunk.length - bodies.length;
    // Group by parent: groups run concurrently, entries under one parent stay
    // sequential (sibling position follows apply order) — the same contract
    // as `object create --batch`.
    const groups = new Map<string, CreateOp[]>();
    for (const c of bodies) {
      const key = c.parentId ?? `root:${c.id}`;
      const group = groups.get(key);
      if (group !== undefined) group.push(c);
      else groups.set(key, [c]);
    }
    const groupQueue = [...groups.values()];
    await Promise.all(
      Array.from({ length: Math.min(16, Math.max(1, groupQueue.length)) }, async () => {
        for (let group = groupQueue.shift(); group !== undefined; group = groupQueue.shift()) {
          for (const c of group) {
            if (createdIds.has(c.id)) continue;
            try {
              const res = await client.postJson<{ id: string }>("/api/objects", {
                id: c.id,
                parentId: c.parentId ?? undefined,
                isEmbedded: c.parentId !== null && c.isEmbedded,
                contentAst: c.contentAst,
                classIds: c.classIds,
              });
              createdIds.add(res.id);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (/already exists/.test(message)) {
                createdIds.add(c.id); // a concurrent run got there first — fine
              } else {
                executionFailures.push({ kind: "create", id: c.id, error: message });
              }
            }
          }
        }
      }),
    );
    createDone += chunk.length;
    progress({ op: "create.chunk", done: createDone, total: allCreates.length, skipped });
  }
  applied.chains = chainCreates.filter((c) => createdIds.has(c.id)).length;
  applied.creates = creates.filter((c) => createdIds.has(c.id)).length;

  // Title updates (the plan holds none unless --strategy newer-wins).
  for (const u of titleUpdates) {
    if (!createdIds.has(u.id)) {
      progress({ op: "title.skip", id: u.id, reason: "missing" });
      continue;
    }
    try {
      await client.patchJson(`/api/objects/${encodeURIComponent(u.id)}`, { contentAst: u.contentAst });
      applied.titles += 1;
      progress({ op: "title.update", done: applied.titles, total: titleUpdates.length, id: u.id });
    } catch (error) {
      executionFailures.push({ kind: "title", id: u.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Property fills (always) + restores (only under --restore-diffs). Resolve
  // the planned schema refs against a fresh listing (the `new:` schemas now
  // exist with real ids).
  const schemaIdByName = new Map<string, string>();
  {
    const fresh = await client.getJson<{ propertySchemas: TargetSchemaRow[] }>("/api/property-schemas");
    for (const s of fresh.propertySchemas) schemaIdByName.set(s.name, s.id);
  }
  const resolveSchemaId = (op: PropOp): string | undefined =>
    op.schemaId.startsWith("new:") ? schemaIdByName.get(op.schemaName) : op.schemaId;

  const applyPropOps = async (ops: PropOp[], kind: "fill" | "restore"): Promise<void> => {
    const queue = [...ops];
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, Math.max(1, queue.length)) }, async () => {
        for (let op = queue.shift(); op !== undefined; op = queue.shift()) {
          if (!createdIds.has(op.nodeId)) {
            progress({ op: `${kind}.skip`, nodeId: op.nodeId, reason: "missing" });
            continue;
          }
          const schemaId = resolveSchemaId(op);
          if (schemaId === undefined) {
            executionFailures.push({ kind, id: `${op.nodeId}/${op.schemaName}`, error: "schema not found after ensure" });
            continue;
          }
          try {
            for (let i = 0; i < op.values.length; i++) {
              await client.postJson(`/api/objects/${encodeURIComponent(op.nodeId)}/properties`, {
                propertySchemaId: schemaId,
                value: op.values[i],
                idx: schemaMulti.get(op.schemaName) === true ? i : 0,
              });
            }
            done += 1;
            if (kind === "fill") applied.fills += 1;
            else applied.restores += 1;
            progress({ op: `${kind}.apply`, done, total: ops.length, nodeId: op.nodeId, schema: op.schemaName });
          } catch (error) {
            executionFailures.push({
              kind,
              id: `${op.nodeId}/${op.schemaName}`,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }),
    );
  };
  await applyPropOps(propFills, "fill");
  if (restoreDiffs) await applyPropOps(propRestores, "restore");

  report.executionFailures = executionFailures;
  const appliedSummary = `applied: ${applied.schemas} schemas, ${applied.chains} chain nodes, ${applied.creates} nodes, ${applied.titles} titles, ${applied.fills} fills, ${applied.restores} restores; ${executionFailures.length} failures`;
  emit(`${humanReport}\n${appliedSummary}\n`, report);
  if (executionFailures.length > 0) {
    throw new CliError(
      EXIT.domain,
      `import logseq-db: ${executionFailures.length} write failure(s) (${executionFailures
        .slice(0, 3)
        .map((f) => `${f.kind} ${f.id}: ${f.error}`)
        .join("; ")}${executionFailures.length > 3 ? "; …" : ""})`,
      report,
    );
  }
}

/** "20261026" → "2026-10-26" for the domain's chainNodeIds/parseIsoDate. */
function isoDay(day: string): string {
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}

async function listAllObjects(client: ApiClient, trashed: boolean): Promise<TargetObjectRow[]> {
  const objects: TargetObjectRow[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: "500" });
    if (trashed) query.set("trashed", "true");
    if (cursor !== undefined) query.set("cursor", cursor);
    const body = await client.getJson<{ objects: TargetObjectRow[]; nextCursor?: string | null }>(
      `/api/objects?${query.toString()}`,
    );
    objects.push(...body.objects);
    cursor = body.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return objects;
}

function renderHumanReport(report: PlanReport): string {
  const lines = [
    `Logseq DB import plan — ${report.export.nodes} export nodes (${report.export.matched} matched, ${report.export.missing} missing, ${report.trashedSkipped} trashed-skipped) against ${report.targetNodes} target nodes`,
    `classes: ${report.classes.mapped} mapped, ${Object.keys(report.classes.unmapped).length} unmapped`,
    `properties: ${report.properties.mapped} mapped, ${report.properties.unmapped.length} unmapped, new schemas: ${report.properties.newSchemas.join(", ") || "none"}`,
    `plan: ${report.plan.creates} creates (${report.plan.chainCreates} date-chain), ${report.plan.titleUpdates} title updates (${report.plan.titleKeepNotees} kept Notees), ${report.plan.propFills} property fills, ${report.plan.propRestores} restores, ${report.plan.propFailures} property failures, ${report.plan.schemaCreates} schema creates, ${report.createWarnings} create warnings, ${report.plan.extraValuesDropped} extra values dropped`,
  ];
  if (Object.keys(report.classes.unmapped).length > 0) {
    lines.push(`unmapped classes: ${Object.entries(report.classes.unmapped).map(([t, c]) => `${t} (${c})`).join(", ")}`);
  }
  if (report.properties.unmapped.length > 0) {
    lines.push(`unmapped properties: ${report.properties.unmapped.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

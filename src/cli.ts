#!/usr/bin/env node
/**
 * `notees` — the Notees CLI.
 *
 * Every command supports --json (stable machine output), --server <url> and
 * --key <credential> (env NOTEES_SERVER / NOTEES_API_KEY as fallbacks), the
 * global --workspace <name|id> (env NOTEES_WORKSPACE) and --profile. The
 * credential is whatever the server resolves: the operator key, a user API
 * key, or an account session token — the client sends it verbatim and maps
 * the server's 401; there is no client-side shape check. Exit codes: 0 ok,
 * 1 domain error, 2 usage, 3 auth, 4 conflict, 5 network. Destructive
 * commands require --yes: without it they print a blast-radius preview and
 * exit 2 (never an interactive prompt when --json or non-tty).
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError, Option } from "commander";

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  chainNodeIds,
  dateNodeId,
  dateNodeLabel,
  parseDateNodeId,
  parseIsoDate,
  type SystemClassName,
  type SystemPropertyName,
} from "@notees/domain";
import {
  bibToCsl,
  concatBundleMarkdown,
  cslToBib,
  cslToNodeSpecs,
  deriveDisplayName,
  nodeToCsl,
  parseBibtex,
  renderJsonArchive,
  serializeBibEntry,
  sourceClassOf,
  yearFromDate,
  type CslItem,
} from "@notees/export";
import { OP_CATALOG, describeOp, newEnvelope, Clock } from "@notees/protocol";
import {
  looksLikeQueryLanguage,
  parseQueryLanguage,
  type QueryAst,
} from "@notees/query";

import { ApiClient } from "./client.js";
import { parseCslJson } from "./csl-json.js";
import { CliError, EXIT } from "./exit-codes.js";
import {
  buildMarkdownBundle,
  collectClosure,
  isRecord,
  makeObjectResolver,
} from "./markdown-export.js";
import { buildJsonArchiveDocument } from "./json-export.js";
import { runShell } from "./shell.js";
import { defaultStatePath, profileDefaults, serverState, updateProfileDefaults, updateServerState, type StoredCredential } from "./state.js";
import { formatTable, queryString, readStdin } from "./util.js";
import { DEFAULT_WORKSPACE_ID, deriveUuid, uuidv7 } from "./uuid.js";
import { parseZoteroRdf, type ZoteroRdfParseResult } from "./zotero-rdf.js";

export interface CliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  stdin?: NodeJS.ReadableStream | undefined;
  isTty?: boolean;
}

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  isTty: process.stdout.isTTY === true,
};

interface GlobalOptions {
  json?: boolean;
  server?: string;
  key?: string;
  workspace?: string;
  profile?: string;
}

interface CommandContext {
  io: CliIo;
  opts: GlobalOptions;
  client: ApiClient;
  statePath: string;
  /** `${profile}:${server}` — the state-file key for this invocation. */
  stateKey: string;
}

function emit(ctx: CommandContext, human: string, machine: unknown): void {
  if (ctx.opts.json) {
    ctx.io.stdout.write(`${JSON.stringify(machine, null, 2)}\n`);
  } else {
    ctx.io.stdout.write(human);
  }
}

function failUsage(message: string): never {
  throw new CliError(EXIT.usage, message);
}

/**
 * Server/workspace resolution order: flag (`--server` / `--workspace`) >
 * env (`NOTEES_SERVER` / `NOTEES_WORKSPACE`) > the stored per-profile
 * defaults from `notees config set` (server: and workspace:).
 */
function requireServer(
  opts: GlobalOptions,
  statePath: string,
): { server: string; workspace: string | undefined } {
  const defaults = profileDefaults(statePath, opts.profile ?? "default");
  const server = opts.server ?? process.env.NOTEES_SERVER ?? defaults.server;
  const workspace = opts.workspace ?? process.env.NOTEES_WORKSPACE ?? defaults.workspace;
  if (server === undefined || server.length === 0) {
    failUsage(
      "server URL required: pass --server <url>, set NOTEES_SERVER, or run `notees config set server <url>`",
    );
  }
  return { server, workspace };
}

/**
 * Credential resolution order: --key > NOTEES_API_KEY > the credential stored
 * by `notees auth login` / `notees auth store` for this profile+server. No
 * client-side shape check:
 * the server resolves operator keys, user API keys, and session tokens, and
 * answers 401 when invalid — a local regex can only reject valid credentials.
 */
function resolveKey(
  opts: GlobalOptions,
  statePath: string,
  stateKey: string,
  allowMissing: boolean,
): { apiKey: string; stored: StoredCredential | undefined } {
  const flag = opts.key ?? process.env.NOTEES_API_KEY;
  if (flag !== undefined && flag.length > 0) return { apiKey: flag, stored: undefined };
  const stored = serverState(statePath, stateKey).credential;
  if (stored !== undefined && stored.token.length > 0) return { apiKey: stored.token, stored };
  if (allowMissing) return { apiKey: "", stored: undefined };
  failUsage("credential required: pass --key, set NOTEES_API_KEY, or run `notees auth login` (or `notees auth store --key`) for this server");
}

// --- command handlers --------------------------------------------------------

async function objectGet(ctx: CommandContext, id: string): Promise<void> {
  const body = await ctx.client.getJson<{ object: unknown }>(`/api/objects/${encodeURIComponent(id)}`);
  emit(ctx, `${JSON.stringify(body.object, null, 2)}\n`, body);
}

/** `notees object get --ids <uuid…>` — multi-read: one fetch per id, in
 * argument order (verification scripts audit bulk imports without a loop). */
async function objectGetMany(ctx: CommandContext, ids: string[]): Promise<void> {
  const objects: unknown[] = [];
  for (const id of ids) {
    const body = await ctx.client.getJson<{ object: unknown }>(`/api/objects/${encodeURIComponent(id)}`);
    objects.push(body.object);
  }
  const human = objects.map((object) => `${JSON.stringify(object, null, 2)}\n`).join("");
  emit(ctx, human, { objects });
}

/** Shared create-body assembly for `object create` / `object upsert`. */
function buildCreateBody(options: {
  isEmbedded?: boolean;
  isClass?: boolean;
  name?: string;
  class?: string[];
  parent?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  // Revision 11 render state: --isClass declares a class node (a root —
  // rejected server-side alongside --parent/--class); --isEmbedded/--no-isEmbedded set
  // the render bit (server default: true when parentless, false when
  // parented).
  if (options.isClass === true) body.isClass = true;
  if (options.isEmbedded !== undefined) body.isEmbedded = options.isEmbedded;
  if (options.name !== undefined) body.name = options.name;
  if (options.parent !== undefined) body.parentId = options.parent;
  const classIds = options.class ?? [];
  if (classIds.length > 0) body.classIds = classIds;
  return body;
}

/**
 * `--content <json>`: a contentAst token array (mentions, markdown links as
 * `[label](href)` spans inside text tokens, … — the server is the strict
 * shape gate). The array-ness is validated
 * client-side so a mistyped scalar fails as usage, not as a wire error.
 */
function parseContentAstOption(raw: string | undefined): unknown[] | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(EXIT.usage, "--content is not valid JSON");
  }
  if (!Array.isArray(parsed)) failUsage("--content expects a JSON array of content tokens (a contentAst)");
  return parsed;
}

/** Flag value that must parse as a non-negative integer (undefined passes through). */
function nonNegativeIntOption(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) failUsage(`${flag} must be a non-negative integer`);
  return value;
}

async function objectCreate(ctx: CommandContext, options: {
  isEmbedded?: boolean;
  isClass?: boolean;
  name?: string;
  content?: string;
  class?: string[];
  parent?: string;
  stdin?: boolean;
  icon?: string;
  color?: string;
}): Promise<void> {
  let body: Record<string, unknown> = {};
  if (options.stdin === true) {
    const raw = await readStdin(ctx.io);
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new CliError(EXIT.usage, "--stdin body is not valid JSON");
    }
  }
  // Title-is-content: --name IS single-token content, so a rich --content
  // array and --name cannot combine (the server would see both shapes).
  const contentAst = parseContentAstOption(options.content);
  if (contentAst !== undefined && options.name !== undefined) {
    failUsage("--name and --content are mutually exclusive (--name becomes one text token; --content carries the whole contentAst)");
  }
  const created = await ctx.client.postJson<{ id: string; object: unknown }>(
    "/api/objects",
    { ...body, ...buildCreateBody(options), ...(contentAst !== undefined ? { contentAst } : {}) },
  );
  // icon/color ride a follow-up patch — the object.create op payload carries
  // no appearance fields (object.update does).
  if (options.icon !== undefined || options.color !== undefined) {
    await ctx.client.patchJson(`/api/objects/${encodeURIComponent(created.id)}`, {
      ...(options.icon !== undefined ? { icon: options.icon } : {}),
      ...(options.color !== undefined ? { color: options.color } : {}),
    });
    const refreshed = await ctx.client.getJson<{ object: unknown }>(`/api/objects/${encodeURIComponent(created.id)}`);
    emit(ctx, `${created.id}\n`, { id: created.id, object: refreshed.object });
    return;
  }
  // Non-json prints the new id only (script-friendly).
  emit(ctx, `${created.id}\n`, created);
}

/**
 * `notees object create --batch` — bulk import from a JSON array on stdin:
 * one create per entry, each entry a POST /api/objects body (`name`,
 * `contentAst`, `parentId`, `isEmbedded`, `classIds`, … — the server
 * validates). Entries group by parent and groups run concurrently; entries
 * under one parent stay sequential, because child position follows apply
 * order and bulk blocks under a single parent must keep their array order.
 * Human output prints the created ids one per line, in input order.
 * Failures are collected and reported (exit 1) unless --stop-on-error.
 */
async function objectCreateBatch(ctx: CommandContext, options: {
  jobs?: string;
  stopOnError?: boolean;
}): Promise<void> {
  const raw = await readStdin(ctx.io);
  let entries: unknown[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    entries = parsed;
  } catch {
    throw new CliError(EXIT.usage, "--batch expects a JSON array of create bodies on stdin");
  }
  if (entries.length === 0) failUsage("--batch expects a non-empty JSON array");
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) failUsage(`--batch entry ${index} is not a JSON object`);
  });

  const jobs = Number.parseInt(options.jobs ?? "8", 10);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 32) failUsage("--jobs must be an integer between 1 and 32");

  // Group by parent (roots are order-independent — each gets its own group).
  const groups = new Map<string, { body: Record<string, unknown>; index: number }[]>();
  entries.forEach((entry, index) => {
    const body = entry as Record<string, unknown>;
    const key = typeof body.parentId === "string" ? `parent:${body.parentId}` : `root:${index}`;
    const list = groups.get(key) ?? [];
    list.push({ body, index });
    groups.set(key, list);
  });

  const created: { index: number; id: string }[] = [];
  const failures: { index: number; error: string }[] = [];
  let stopped = false;
  const queue = [...groups.values()];
  let done = 0;

  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let group = queue.shift(); group !== undefined; group = queue.shift()) {
        for (const { body, index } of group) {
          if (stopped) {
            failures.push({ index, error: "skipped (--stop-on-error)" });
            continue;
          }
          try {
            const res = await ctx.client.postJson<{ id: string }>("/api/objects", body);
            created.push({ index, id: res.id });
          } catch (error) {
            failures.push({ index, error: error instanceof Error ? error.message : String(error) });
            if (options.stopOnError === true) stopped = true;
          }
          done += 1;
          if (done % 500 === 0) {
            ctx.io.stderr.write(`notees: batch ${done}/${entries.length}\n`);
          }
        }
      }
    }),
  );

  const ids = [...created].sort((a, b) => a.index - b.index).map((entry) => entry.id);
  const machine = {
    created: ids.length,
    ids,
    failures: [...failures].sort((a, b) => a.index - b.index),
  };
  emit(ctx, ids.map((id) => `${id}\n`).join(""), machine);
  if (failures.length > 0) {
    const detail = machine.failures
      .slice(0, 5)
      .map((failure) => `#${failure.index}: ${failure.error}`)
      .join("; ");
    throw new CliError(
      EXIT.domain,
      `--batch: ${failures.length}/${entries.length} failed (${detail}${failures.length > 5 ? "; …" : ""})`,
      machine,
    );
  }
}

/**
 * `notees object children <id>` — direct children in child-position order
 * (both render zones: main children and inline body blocks), wrapping the
 * endpoint the editor's bullet renderer reads. The endpoint returns the full
 * child list in one response (it is unpaginated server-side), so the
 * windowing flags slice client-side: `--offset`/`--limit` page the listing,
 * `--count` prints just the cardinality, and `--fields` projects each row to
 * the named keys (`id` is always kept). The machine surface reports `total`
 * (the un-sliced count) alongside the window.
 */
async function objectChildren(ctx: CommandContext, id: string, options: {
  limit?: string;
  offset?: string;
  count?: boolean;
  fields?: string;
}): Promise<void> {
  const body = await ctx.client.getJson<{ children: Array<Record<string, unknown>> }>(
    `/api/objects/${encodeURIComponent(id)}/children`,
  );
  const all = body.children;
  if (options.count === true) {
    emit(ctx, `${all.length}\n`, { id, count: all.length });
    return;
  }
  const offset = nonNegativeIntOption(options.offset, "--offset") ?? 0;
  const limit = nonNegativeIntOption(options.limit, "--limit");
  let children = all.slice(offset);
  if (limit !== undefined) children = children.slice(0, limit);

  let fields: string[] | undefined;
  if (options.fields !== undefined) {
    const wanted = options.fields.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
    if (wanted.length === 0) failUsage("--fields expects a comma-separated list of keys");
    fields = wanted;
    children = children.map((child) => {
      const projected: Record<string, unknown> = {};
      for (const name of wanted) {
        if (name in child) projected[name] = child[name];
      }
      if (!("id" in projected) && typeof child.id === "string") projected.id = child.id;
      return projected;
    });
  }

  const machine: Record<string, unknown> = {
    children,
    total: all.length,
    ...(offset > 0 ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };

  if (fields !== undefined) {
    const header = fields.includes("id") ? fields : [...fields, "id"];
    const cell = (value: unknown): string =>
      value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    const rows = children.map((child) => header.map((name) => cell(child[name])));
    const suffix =
      offset > 0 || limit !== undefined
        ? `# showing ${children.length} of ${all.length} children (offset ${offset}${limit !== undefined ? `, limit ${limit}` : ""})\n`
        : "";
    emit(ctx, `${formatTable([header.map((name) => name.toUpperCase()), ...rows])}\n${suffix}`, machine);
    return;
  }

  const rows = children.map((child) => [
    typeof child.name === "string" && child.name.length > 0 ? child.name : "(untitled)",
    renderKindLabel(child as { isClass?: boolean; isEmbedded?: boolean; parentId?: string | null }),
    String(child.id),
  ]);
  const suffix =
    offset > 0 || limit !== undefined
      ? `# showing ${children.length} of ${all.length} children (offset ${offset}${limit !== undefined ? `, limit ${limit}` : ""})\n`
      : "";
  emit(ctx, `${formatTable([["NAME", "KIND", "ID"], ...rows])}\n${suffix}`, machine);
}

/**
 * `notees object restore <id>…` — bring trashed nodes back (whole-tree per
 * the object.restore op; descendants trashed independently stay trashed).
 * Ids apply sequentially; a permanently deleted id fails loud (exit 1).
 */
async function objectRestore(ctx: CommandContext, ids: string[]): Promise<void> {
  if (ids.length === 0) failUsage("object restore requires at least one id");
  const restored: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const body = await ctx.client.postJson<{ object: Record<string, unknown> }>(
      `/api/objects/${encodeURIComponent(id)}/restore`,
      {},
    );
    restored.push(body.object);
  }
  emit(
    ctx,
    restored.map((object) => `${String(object.id)}\n`).join(""),
    { restored: restored.map((object) => object.id), objects: restored },
  );
}

/** The merge plan summary — the server's POST /objects/:id/merge contract. */
interface MergeSummary {
  childrenMoved: number;
  classesRemapped: number;
  tagsRemapped: number;
  propertiesCopied: number;
  propertiesSkipped: number;
  contentLinksRewritten: number;
  propertyValuesRewritten: number;
  aliasesRepointed: number;
  collectionsRemapped: number;
  fieldsCopied: number;
}

/** One human line over the plan's nonzero counts. */
function renderMergeSummary(summary: MergeSummary): string {
  const parts: string[] = [];
  if (summary.childrenMoved > 0) parts.push(`${summary.childrenMoved} children moved`);
  if (summary.classesRemapped > 0 || summary.tagsRemapped > 0) {
    parts.push(`${summary.classesRemapped} classes + ${summary.tagsRemapped} tags remapped`);
  }
  if (summary.propertiesCopied > 0) {
    parts.push(
      `${summary.propertiesCopied} properties copied` +
        (summary.propertiesSkipped > 0 ? ` (${summary.propertiesSkipped} skipped — target already had a value)` : ""),
    );
  } else if (summary.propertiesSkipped > 0) {
    parts.push(`${summary.propertiesSkipped} properties kept (target already had values)`);
  }
  if (summary.contentLinksRewritten > 0) parts.push(`${summary.contentLinksRewritten} pages' mentions retargeted`);
  if (summary.propertyValuesRewritten > 0) parts.push(`${summary.propertyValuesRewritten} property references retargeted`);
  if (summary.aliasesRepointed > 0) parts.push(`${summary.aliasesRepointed} aliases repointed`);
  if (summary.collectionsRemapped > 0) parts.push(`${summary.collectionsRemapped} collections remapped`);
  if (summary.fieldsCopied > 0) parts.push(`${summary.fieldsCopied} fields copied`);
  return parts.length > 0 ? parts.join(", ") : "nothing to remap";
}

async function objectMerge(
  ctx: CommandContext,
  sourceRef: string,
  targetRef: string,
  options: { dryRun?: boolean; yes?: boolean },
): Promise<void> {
  if (sourceRef === targetRef) failUsage("object merge: source and target are the same node");
  const named = async (ref: string): Promise<{ id: string; name: string }> => {
    const body = await ctx.client.getJson<{ object: { id: string; name?: string | null } }>(
      `/api/objects/${encodeURIComponent(ref)}`,
    );
    return { id: body.object.id, name: body.object.name ?? body.object.id };
  };
  const source = await named(sourceRef);
  const target = await named(targetRef);
  const plan = { source, target };
  const preview = `merge "${source.name}" into "${target.name}" — children move, references retarget, the source trashes`;
  if (options.dryRun === true) {
    const res = await ctx.client.postJson<{ dryRun: boolean; summary: MergeSummary }>(
      `/api/objects/${encodeURIComponent(source.id)}/merge?dryRun=true`,
      { targetId: target.id },
    );
    emit(ctx, `dry run: ${preview}\n  ${renderMergeSummary(res.summary)}\n`, {
      ...plan,
      dryRun: true,
      summary: res.summary,
    });
    return;
  }
  if (options.yes !== true) {
    ctx.io.stderr.write(`Refusing to merge: ${preview}.\nRe-run with --yes to proceed (or --dry-run to inspect).\n`);
    throw new CliError(EXIT.usage, "destructive command requires --yes", { plan });
  }
  const res = await ctx.client.postJson<{ merged: boolean; targetId: string; summary: MergeSummary }>(
    `/api/objects/${encodeURIComponent(source.id)}/merge`,
    { targetId: target.id },
  );
  emit(ctx, `merged "${source.name}" into "${target.name}" — ${renderMergeSummary(res.summary)}\n`, {
    ...plan,
    merged: res.merged,
    summary: res.summary,
  });
}

/**
 * `notees object upsert` — find-or-create by exact title (case-insensitive)
 * within optional scopes (--class, --parent). Zero matches → create with
 * the same flags as `object create`; one → print its id, no write; many →
 * usage error telling the caller to narrow the scopes. Lets import scripts
 * re-run without duplicating nodes.
 */
async function objectUpsert(ctx: CommandContext, options: {
  name?: string;
  class?: string[];
  parent?: string;
  isEmbedded?: boolean;
}): Promise<void> {
  const name = options.name ?? "";
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0) failUsage("object upsert requires a non-empty --name");
  const classIds = options.class ?? [];
  // Title lookup rides the object listing (exact-name filter client-side);
  // a single-class scope narrows the server query.
  const query = queryString({
    q: name,
    ...(classIds.length === 1 ? { class: classIds[0] } : {}),
    limit: 500,
  });
  const body = await ctx.client.getJson<{ objects: Array<Record<string, unknown>> }>(`/api/objects${query}`);
  const matches = body.objects.filter((object) => {
    if (typeof object.name !== "string" || object.name.trim().toLowerCase() !== wanted) return false;
    const classes = Array.isArray(object.classIds) ? object.classIds : [];
    if (classIds.length > 0 && !classIds.every((id) => classes.includes(id))) return false;
    if (options.parent !== undefined && object.parentId !== options.parent) return false;
    return true;
  });
  if (matches.length > 1) {
    const shown = matches
      .map((match) => String(match.id))
      .slice(0, 5)
      .join(", ");
    failUsage(
      `upsert ambiguous: ${matches.length} objects named "${name}" in scope — narrow with --class/--parent ` +
        `(matches: ${shown}${matches.length > 5 ? ", …" : ""})`,
    );
  }
  if (matches.length === 1) {
    const existing = matches[0]!;
    emit(ctx, `${String(existing.id)}\n`, { id: existing.id, created: false, object: existing });
    return;
  }
  const createBody = buildCreateBody({
    name,
    class: classIds,
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
    ...(options.isEmbedded !== undefined ? { isEmbedded: options.isEmbedded } : {}),
  });
  const created = await ctx.client.postJson<{ id: string; object: unknown }>("/api/objects", createBody);
  emit(ctx, `${created.id}\n`, { ...created, created: true });
}

async function objectUpdate(ctx: CommandContext, id: string, options: {
  name?: string;
  content?: string;
  isEmbedded?: boolean;
  icon?: string;
  color?: string;
}): Promise<void> {
  const body: Record<string, unknown> = {};
  const contentAst = parseContentAstOption(options.content);
  if (contentAst !== undefined && options.name !== undefined) {
    failUsage("--name and --content are mutually exclusive (--name becomes one text token; --content carries the whole contentAst)");
  }
  // Title-is-content: --name rewrites the node's text content (its title).
  if (options.name !== undefined) {
    body.contentAst = [{ type: "text", text: options.name }];
  }
  if (contentAst !== undefined) body.contentAst = contentAst;
  // Promotion/demotion: flip the embedding flag between the standalone
  // Page role (false) and the embedded Block role (true).
  if (options.isEmbedded !== undefined) body.isEmbedded = options.isEmbedded;
  if (options.icon !== undefined) body.icon = options.icon;
  if (options.color !== undefined) {
    // Color grammar (SCHEMA.md): preset token or #RRGGBB; "none" clears.
    body.color = options.color.toLowerCase() === "none" ? null : options.color;
  }
  if (Object.keys(body).length === 0) {
    failUsage("object update requires at least one of --name, --content, --isEmbedded, --icon, --color");
  }
  const updated = await ctx.client.patchJson<{ object: unknown }>(
    `/api/objects/${encodeURIComponent(id)}`,
    body,
  );
  emit(ctx, `${JSON.stringify(updated.object, null, 2)}\n`, updated);
}

/**
 * Render-state vocabulary for human output (Revision 11): the booleans read
 * as the retired page/block/class words — a class node is a "class", a
 * non-class node with document chrome (parentless or render-bit set) is a
 * "page", and a parented node with the bit unset is a "block".
 */
function renderKindLabel(node: { isClass?: boolean; isEmbedded?: boolean; parentId?: string | null }): string {
  if (node.isClass === true) return "class";
  if (node.isClass === false) {
    return node.parentId === null || node.isEmbedded === false ? "page" : "block";
  }
  return "object";
}

async function objectDelete(ctx: CommandContext, id: string, options: { permanent?: boolean; yes?: boolean }): Promise<void> {
  const permanent = options.permanent === true;
  if (options.yes !== true) {
    // Blast-radius preview — never prompt when --json or non-tty.
    let preview: { name?: string | null; isClass?: boolean; isEmbedded?: boolean } = {};
    try {
      const fetched = await ctx.client.getJson<{ object: { name?: string | null; isClass?: boolean; isEmbedded?: boolean } }>(
        `/api/objects/${encodeURIComponent(id)}`,
      );
      preview = fetched.object;
    } catch (error) {
      if (error instanceof CliError && error.exitCode === EXIT.domain) throw error;
      throw error;
    }
    const scope = permanent ? "permanently delete (unrecoverable)" : "move to trash";
    const label = preview.name !== null && preview.name !== undefined && preview.name.length > 0 ? `"${preview.name}"` : id;
    ctx.io.stderr.write(
      `Refusing to ${scope} ${label} (${renderKindLabel(preview)}) without confirmation.\n` +
        `Re-run with --yes to proceed. Deleted object id: ${id}\n`,
    );
    throw new CliError(EXIT.usage, "destructive command requires --yes", { preview });
  }
  const query = permanent ? `?permanent=true&confirm=${encodeURIComponent(id)}` : "";
  const result = await ctx.client.deleteJson<{ id: string; deleted: boolean; permanent: boolean }>(
    `/api/objects/${encodeURIComponent(id)}${query}`,
  );
  emit(ctx, `deleted ${result.id}${result.permanent ? " (permanent)" : ""}\n`, result);
}

async function objectList(ctx: CommandContext, options: {
  isClass?: boolean;
  isEmbedded?: boolean;
  class?: string[];
  parent?: string;
  trashed?: boolean;
  q?: string;
  property?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
}): Promise<void> {
  const classes = options.class ?? [];
  // --all follows the pagination cursor to exhaustion (server page size,
  // defaulting to its 500 max so big workspaces take few round trips).
  const limit =
    options.limit !== undefined
      ? Number.parseInt(options.limit, 10)
      : options.all === true
        ? 500
        : undefined;
  const pageParams = {
    isClass: options.isClass,
    isEmbedded: options.isEmbedded,
    ...(classes.length === 1 ? { class: classes[0] } : {}),
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
    ...(options.trashed === true ? { trashed: "true" } : {}),
    q: options.q,
    property: options.property,
    limit,
  };
  const objects: Array<Record<string, unknown>> = [];
  let cursor = options.cursor;
  let nextCursor: string | null | undefined;
  do {
    const query = queryString({ ...pageParams, cursor });
    const body = await ctx.client.getJson<{ objects: Array<Record<string, unknown>>; nextCursor?: string | null }>(
      `/api/objects${query}`,
    );
    objects.push(...body.objects);
    nextCursor = body.nextCursor ?? null;
    cursor = body.nextCursor ?? undefined;
  } while (options.all === true && cursor !== undefined);
  const machine = { objects, nextCursor: options.all === true ? null : (nextCursor ?? null) };
  const rows = objects.map((object) => [
    typeof object.name === "string" && object.name.length > 0 ? object.name : "(untitled)",
    renderKindLabel(object as { isClass?: boolean; isEmbedded?: boolean; parentId?: string | null }),
    String(object.id),
  ]);
  emit(ctx, `${formatTable([["NAME", "KIND", "ID"], ...rows])}\n`, machine);
}

async function search(ctx: CommandContext, queryText: string, options: { isClass?: boolean; isEmbedded?: boolean }): Promise<void> {
  // Plain text goes to the FTS endpoint; query-language syntax (class:,
  // prop:…, AND/OR/NOT, quotes — see looksLikeQueryLanguage) is compiled to a
  // QueryAST here and executed through POST /api/query. DSL parse errors
  // fail loud (exit 2) with the parser's message — never silently degraded
  // to a text search.
  if (!looksLikeQueryLanguage(queryText)) {
    const query = queryString({ q: queryText, isClass: options.isClass, isEmbedded: options.isEmbedded });
    const body = await ctx.client.getJson<unknown>(`/api/search${query}`);
    emit(ctx, `${JSON.stringify(body, null, 2)}\n`, body);
    return;
  }
  const ast = await compileQueryLanguage(ctx, queryText);
  const body = await ctx.client.postJson<{ ids: string[]; rows: SearchRow[] }>("/api/query", { ast });
  const rows = body.rows ?? [];
  const human = rows.length === 0
    ? "no results\n"
    : `${rows.map((row) => `${row.name ?? row.id}  (${renderKindLabel(row)})`).join("\n")}\n`;
  emit(ctx, human, body);
}

interface SearchRow {
  id: string;
  isClass: boolean;
  isEmbedded: boolean;
  parentId: string | null;
  name: string | null;
}

/**
 * DSL → AST for `notees search`: resolve class/schema names via the classes
 * and property-schemas listings, and `linked:` node names via the search
 * endpoint (prefetched — the parser's resolver interface is synchronous). The
 * query compiler is TypeScript, so the compile happens here; execution needs
 * the derived-store runtime, which lives server-side. Resolvers also pass
 * uuids through verbatim (name-or-uuid refs, like the object's own --class
 * filter), so scripts can query by id without knowing display names.
 */
async function compileQueryLanguage(ctx: CommandContext, text: string): Promise<QueryAst> {
  const [{ classes }, { propertySchemas }] = await Promise.all([
    ctx.client.getJson<{ classes: { id: string; name: string }[] }>("/api/classes"),
    ctx.client.getJson<{ propertySchemas: { id: string; name: string }[] }>("/api/property-schemas"),
  ]);
  const classIds = new Map(classes.map((klass) => [klass.name.toLowerCase(), klass.id]));
  const schemaIds = new Map(propertySchemas.map((schema) => [schema.name.toLowerCase(), schema.id]));

  // linked:<name> resolution: the resolver endpoint (the
  // /api/search prefetch kludge it replaced could rank the match away).
  // Uuid refs resolve by passthrough — no name lookup needed (or possible).
  const nodeIds = new Map<string, string>();
  for (const name of extractLinkedNames(text)) {
    const wanted = name.toLowerCase();
    if (nodeIds.has(wanted) || CLASS_UUID_PATTERN.test(name)) continue;
    const body = await ctx.client.getJson<{ id: string } | { error: string }>(
      `/api/resolve${queryString({ name })}`,
    );
    if ("id" in body) nodeIds.set(wanted, body.id);
  }

  try {
    return parseQueryLanguage(text, {
      resolvers: {
        resolveClass: (name) => classIds.get(name.toLowerCase()) ?? (CLASS_UUID_PATTERN.test(name) ? name : undefined),
        resolvePropertySchema: (name) =>
          schemaIds.get(name.toLowerCase()) ?? (PROPERTY_UUID_PATTERN.test(name) ? name : undefined),
        resolveNode: (name) => nodeIds.get(name.toLowerCase()) ?? (CLASS_UUID_PATTERN.test(name) ? name : undefined),
      },
      knownFields: propertySchemas.map((schema) => schema.name),
    });
  } catch (error) {
    throw new CliError(EXIT.usage, `invalid query: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const LINKED_NAME_PATTERN = /\blinked\s*(?::|!=)\s*("([^"]*)"|'([^']*)'|[^\s)]+)/gi;

/** Names referenced by `linked:` / `linked!=` clauses (for the prefetch pass). */
function extractLinkedNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(LINKED_NAME_PATTERN)) {
    const name = match[2] ?? match[3] ?? match[1];
    if (name !== undefined && name !== "") names.push(name);
  }
  return names;
}

interface ApiClassRow {
  id: string;
  name: string;
  memberCount: number;
  parentClassIds: string[];
}

/** One node of the `--tree` machine surface (nested, additive-only field). */
interface ClassTreeNode {
  id: string;
  name: string;
  memberCount: number;
  children: ClassTreeNode[];
}

const displayClassName = (name: string): string => (name.length > 0 ? name : "(untitled)");

/**
 * The `--tree` view of the class listing: the extends DAG rendered as an
 * indented tree (two spaces per level). Roots are parentless classes; a class
 * extending several parents renders under each, tagged with the others; a
 * cycle on the current path renders `(cycle)` and stops.
 */
function buildClassTree(classes: ApiClassRow[]): { roots: ClassTreeNode[]; lines: string[] } {
  const byId = new Map(classes.map((klass) => [klass.id, klass]));
  const childrenOf = new Map<string, ClassTreeNode[]>();
  const nodeOf = new Map<string, ClassTreeNode>();
  for (const klass of classes) {
    const node: ClassTreeNode = { id: klass.id, name: klass.name, memberCount: klass.memberCount, children: [] };
    nodeOf.set(klass.id, node);
    for (const parentId of klass.parentClassIds ?? []) {
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(node);
      childrenOf.set(parentId, siblings);
    }
  }
  const byName = (a: ClassTreeNode, b: ClassTreeNode): number =>
    displayClassName(a.name).localeCompare(displayClassName(b.name));
  const roots = classes
    .filter((klass) => (klass.parentClassIds ?? []).length === 0)
    .map((klass) => nodeOf.get(klass.id)!)
    .sort(byName);
  for (const siblings of childrenOf.values()) siblings.sort(byName);
  // The machine tree nests through the nodes' own children arrays — point
  // them at the sorted adjacency lists (a multi-parent node is shared across
  // its parents' lists; JSON serialization duplicates it, which is intended).
  for (const [id, siblings] of childrenOf) nodeOf.get(id)!.children = siblings;

  const lines: string[] = [];
  const renderNode = (node: ClassTreeNode, depth: number, onPath: Set<string>): void => {
    const indent = "  ".repeat(depth);
    if (onPath.has(node.id)) {
      lines.push(`${indent}${displayClassName(node.name)} (cycle)`);
      return;
    }
    // Other parents beyond the one this rendering hangs under (cycles on the
    // path excluded — the edge back to the ancestor is the cycle itself).
    const otherParents = (byId.get(node.id)?.parentClassIds ?? [])
      .filter((parentId) => !onPath.has(parentId))
      .map((parentId) => displayClassName(byId.get(parentId)?.name ?? parentId))
      .sort((a, b) => a.localeCompare(b));
    const tag = depth > 0 && otherParents.length > 0 ? ` [also under: ${otherParents.join(", ")}]` : "";
    lines.push(`${indent}${displayClassName(node.name)} (${node.memberCount})${tag}`);
    const nextPath = new Set(onPath);
    nextPath.add(node.id);
    for (const child of node.children) renderNode(child, depth + 1, nextPath);
  };
  for (const root of roots) renderNode(root, 0, new Set());
  return { roots, lines };
}

async function classList(ctx: CommandContext, options: { tree?: boolean }): Promise<void> {
  const body = await ctx.client.getJson<{ classes: ApiClassRow[] }>("/api/classes");
  if (options.tree === true) {
    const { roots, lines } = buildClassTree(body.classes);
    emit(ctx, `${lines.join("\n")}\n`, { ...body, tree: roots });
    return;
  }
  const rows = body.classes.map((klass) => [
    displayClassName(klass.name),
    String(klass.memberCount),
    klass.id,
  ]);
  emit(ctx, `${formatTable([["NAME", "MEMBERS", "ID"], ...rows])}\n`, body);
}

/**
 * Membership listing behind remap/empty/delete-members. Without a parent
 * scope it is the class detail's member list; `--parent` re-queries through
 * the objects endpoint (class × parent filter, cursor-followed) because the
 * class detail payload carries no parent ids. Both read the same derived
 * projection (present OR-Set rows, active nodes).
 */
async function classMembers(ctx: CommandContext, classId: string, parentId?: string): Promise<Array<{ id: string }>> {
  if (parentId === undefined) {
    const detail = await ctx.client.getJson<{ members: Array<{ id: string }> }>(
      `/api/classes/${encodeURIComponent(classId)}`,
    );
    return detail.members;
  }
  const members: Array<{ id: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.client.getJson<{ objects: Array<{ id: string }>; nextCursor?: string | null }>(
      `/api/objects${queryString({ class: classId, parent: parentId, limit: 500, cursor })}`,
    );
    members.push(...page.objects);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return members;
}

/**
 * `notees class remap <from> <to>` — the bulk membership migration verb: move
 * every member of FROM to TO (assign + unassign, idempotent ops), remap
 * extends edges pointing at FROM onto TO, leave the emptied FROM class in
 * place (deletion is a separate, deliberate step). Preview-first like the
 * destructive commands: without --yes it prints the blast radius and exits 2;
 * --dry-run prints it and exits 0. `--parent` scopes the move to members whose
 * direct parent is the given node (direct-children scope — subtree-wide
 * scoping rides the query language); `--jobs` parallelizes the per-member
 * moves (membership is an OR-Set, so moves are order-free).
 */
async function classRemap(
  ctx: CommandContext,
  fromRef: string,
  toRef: string,
  options: { dryRun?: boolean; yes?: boolean; parent?: string; jobs?: string },
): Promise<void> {
  const from = await resolveClassRef(ctx, fromRef);
  const to = await resolveClassRef(ctx, toRef);
  if (from.id === to.id) failUsage("class remap: from and to are the same class");
  const jobs = Number.parseInt(options.jobs ?? "8", 10);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 32) failUsage("--jobs must be an integer between 1 and 32");
  const members = await classMembers(ctx, from.id, options.parent);
  const { classes } = await ctx.client.getJson<{
    classes: Array<{ id: string; parentClassIds: string[] }>;
  }>("/api/classes");
  // An extender equal to the target is skipped: remap cannot make TO extend itself.
  const extenders = classes.filter((c) => (c.parentClassIds ?? []).includes(from.id) && c.id !== to.id);
  const plan = {
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
    members: members.length,
    extenders: extenders.length,
  };
  const scope = options.parent !== undefined ? ` (under parent ${options.parent})` : "";
  const preview = `${plan.members} members of "${from.name}"${scope} → "${to.name}", ${plan.extenders} extends edges remapped (the emptied class stays)`;
  if (options.dryRun === true) {
    emit(ctx, `dry run: ${preview}\n`, { ...plan, dryRun: true });
    return;
  }
  if (options.yes !== true) {
    ctx.io.stderr.write(`Refusing to remap: ${preview}.\nRe-run with --yes to proceed (or --dry-run to inspect).\n`);
    throw new CliError(EXIT.usage, "destructive command requires --yes", { plan });
  }
  let moved = 0;
  const failures: Array<{ id: string; error: string }> = [];
  const queue = members.map((member) => member.id);
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          await ctx.client.putJson(`/api/objects/${encodeURIComponent(id)}/classes/${encodeURIComponent(to.id)}`);
          await ctx.client.deleteJson(
            `/api/objects/${encodeURIComponent(id)}/classes/${encodeURIComponent(from.id)}`,
          );
          moved += 1;
        } catch (error) {
          failures.push({ id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }),
  );
  // Extends remap rides the op log — there is deliberately no REST surface
  // for setExtends (configuration write; scripts use the same envelope path
  // as every other client).
  let extendsRemapped = 0;
  if (extenders.length > 0) {
    const clock = new Clock("notees-cli");
    const actorId = deriveUuid(`notees:actor:cli:${ctx.client.apiKey}`);
    const workspaceId = (await ctx.client.workspaceId()) ?? DEFAULT_WORKSPACE_ID;
    const envelopes = extenders.map((extender) =>
      newEnvelope({
        workspaceId,
        actorId,
        deviceId: "notees-cli",
        client: "cli",
        hlc: clock.now(),
        affectedNodeIds: [extender.id],
        opType: "class.setExtends",
        payload: {
          classId: extender.id,
          parentClassIds: [...new Set(extender.parentClassIds.map((p) => (p === from.id ? to.id : p)))],
        },
      }),
    );
    const res = await ctx.client.postJson<{ savedCount: number }>("/api/relay/v2/batch", { envelopes });
    extendsRemapped = res.savedCount;
  }
  emit(
    ctx,
    `remapped ${moved}/${plan.members} members (${failures.length} failures), ${extendsRemapped}/${plan.extenders} extends\n`,
    { ...plan, moved, failures, extendsRemapped },
  );
}

/**
 * `notees object move <id> --parent <id>` — move a node under a new parent,
 * optionally anchored next to a sibling (--after/--before). Placement is
 * log-only state: the write rides the object.move op through the relay batch
 * endpoint (the one write path), like every other client. The MoveGuard
 * invariants apply server-side (no standalone child under a non-page parent,
 * no demoting a page with standalone children).
 */
async function objectMove(ctx: CommandContext, id: string, options: {
  parent?: string;
  after?: string;
  before?: string;
}): Promise<void> {
  if (options.parent === undefined) failUsage("object move requires --parent <id>");
  if (options.after !== undefined && options.before !== undefined) {
    failUsage("--after and --before are mutually exclusive");
  }
  const clock = new Clock("notees-cli");
  const actorId = deriveUuid(`notees:actor:cli:${ctx.client.apiKey}`);
  const workspaceId = (await ctx.client.workspaceId()) ?? DEFAULT_WORKSPACE_ID;
  const envelope = newEnvelope({
    workspaceId,
    actorId,
    deviceId: "notees-cli",
    client: "cli",
    hlc: clock.now(),
    affectedNodeIds: [id, options.parent],
    opType: "object.move",
    payload: {
      objectId: id,
      parentId: options.parent,
      ...(options.after !== undefined ? { afterId: options.after } : {}),
      ...(options.before !== undefined ? { beforeId: options.before } : {}),
    },
  });
  await ctx.client.postJson<{ savedCount: number }>("/api/relay/v2/batch", { envelopes: [envelope] });
  const body = await ctx.client.getJson<{
    object: { id: string; parentId: string | null; name?: string | null };
  }>(`/api/objects/${encodeURIComponent(id)}`);
  emit(ctx, `${body.object.id}\n`, { moved: body.object.id, parent: body.object.parentId, object: body.object });
}

/**
 * `notees ops [opType]` — the op catalog (from @notees/protocol's OP_CATALOG):
 * the discovery layer for the shell's submitOp. No argument lists every op
 * type with a one-line description; an argument prints the full entry.
 */
async function opsList(ctx: CommandContext, opType?: string): Promise<void> {
  if (opType !== undefined) {
    const entry = describeOp(opType);
    if (entry === null) {
      failUsage(`unknown op type "${opType}" — catalogued: ${OP_CATALOG.map((e) => e.opType).join(", ")}`);
    }
    emit(
      ctx,
      `${entry.opType}\n  ${entry.description}\n  affected: ${entry.affected}\n  example: ${JSON.stringify(entry.example)}\n`,
      entry,
    );
    return;
  }
  const table = formatTable(
    [["OP", "DESCRIPTION"], ...OP_CATALOG.map((entry) => [entry.opType, entry.description])],
    110,
  );
  emit(ctx, `${table}\n`, { ops: OP_CATALOG });
}

const CLASS_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Class argument: a uuid is used verbatim; anything else resolves against
 * the workspace's class list by (case-insensitive) title — the assign and
 * unassign commands take "source", not just the system class's fixed id.
 */
async function resolveClassRef(ctx: CommandContext, ref: string): Promise<{ id: string; name: string }> {
  if (CLASS_UUID_PATTERN.test(ref)) return { id: ref, name: ref };
  const body = await ctx.client.getJson<{ classes: { id: string; name: string }[] }>("/api/classes");
  const wanted = ref.trim().toLowerCase();
  const matches = body.classes.filter((klass) => klass.name.toLowerCase() === wanted);
  if (matches.length === 0) {
    failUsage(`no class named "${ref}" (pass a class id, or one of the listed titles)`);
  }
  if (matches.length > 1) {
    failUsage(`class name "${ref}" is ambiguous (${matches.length} classes share it) — pass a class id`);
  }
  return matches[0]!;
}

async function classMembership(
  ctx: CommandContext,
  objectId: string,
  classRef: string,
  action: "assign" | "unassign",
): Promise<void> {
  const klass = await resolveClassRef(ctx, classRef);
  const url = `/api/objects/${encodeURIComponent(objectId)}/classes/${encodeURIComponent(klass.id)}`;
  // Both ops are idempotent: assign re-adds (OR-Set add-wins), unassign
  // tombstones (a no-op when the membership is already absent).
  const body =
    action === "assign"
      ? await ctx.client.putJson<{ object: { classIds: string[] } }>(url)
      : await ctx.client.deleteJson<{ object: { classIds: string[] } }>(url);
  const machine = { objectId, classId: klass.id, className: klass.name, classIds: body.object.classIds };
  emit(ctx, `${action}ed ${objectId} — classes now: ${machine.classIds.join(", ") || "(none)"}\n`, machine);
}

/**
 * Shared bulk-membership verb behind `class empty` (unassign every member —
 * idempotent and non-destructive, no confirmation) and
 * `class delete-members` (trash every member node — preview-first like
 * remap: without --yes it prints the blast radius and exits 2, --dry-run
 * prints and exits 0).
 */
async function classBulkMembers(
  ctx: CommandContext,
  classRef: string,
  action: "unassign" | "trash",
  options: { dryRun?: boolean; yes?: boolean; parent?: string },
): Promise<void> {
  const klass = await resolveClassRef(ctx, classRef);
  const members = await classMembers(ctx, klass.id, options.parent);
  const plan = {
    class: { id: klass.id, name: klass.name },
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
    members: members.length,
    action,
  };
  const scope = options.parent !== undefined ? ` under parent ${options.parent}` : "";
  const preview =
    action === "unassign"
      ? `unassign ${plan.members} members from "${klass.name}"${scope} (the nodes stay, only the membership goes)`
      : `trash ${plan.members} member nodes of "${klass.name}"${scope} (recoverable from the trash)`;
  if (options.dryRun === true) {
    emit(ctx, `dry run: ${preview}\n`, { ...plan, dryRun: true });
    return;
  }
  if (action === "trash" && options.yes !== true) {
    ctx.io.stderr.write(`Refusing to ${preview}.\nRe-run with --yes to proceed (or --dry-run to inspect).\n`);
    throw new CliError(EXIT.usage, "destructive command requires --yes", { plan });
  }
  let done = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const member of members) {
    try {
      if (action === "unassign") {
        await ctx.client.deleteJson(
          `/api/objects/${encodeURIComponent(member.id)}/classes/${encodeURIComponent(klass.id)}`,
        );
      } else {
        await ctx.client.deleteJson(`/api/objects/${encodeURIComponent(member.id)}`);
      }
      done += 1;
    } catch (error) {
      failures.push({ id: member.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const verb = action === "unassign" ? "unassigned" : "trashed";
  emit(ctx, `${verb} ${done}/${plan.members} members of "${klass.name}" (${failures.length} failures)\n`, {
    ...plan,
    done,
    failures,
  });
}

async function backlinks(ctx: CommandContext, id: string): Promise<void> {
  const body = await ctx.client.getJson<unknown>(`/api/objects/${encodeURIComponent(id)}/backlinks`);
  emit(ctx, `${JSON.stringify(body, null, 2)}\n`, body);
}

/** Upload bytes (optionally attaching to a node) — returns the CAS asset id, no output. */
async function uploadAsset(ctx: CommandContext, filePath: string, objectId?: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new CliError(EXIT.usage, `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const form = new FormData();
  form.append("file", new Blob([bytes]), basename(filePath));
  if (objectId !== undefined) form.append("objectId", objectId);
  const body = await ctx.client.postMultipart<{ assetId: string }>("/api/assets", form);
  return body.assetId;
}

async function assetAdd(ctx: CommandContext, filePath: string, options: { object?: string }): Promise<void> {
  const assetId = await uploadAsset(ctx, filePath, options.object);
  emit(ctx, `${assetId}\n`, { assetId });
}

async function assetGet(ctx: CommandContext, id: string, options: { output?: string }): Promise<void> {
  const response = await ctx.client.getBytes(`/api/assets/${encodeURIComponent(id)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (options.output !== undefined) {
    writeFileSync(options.output, bytes);
    emit(ctx, `wrote ${bytes.length} bytes to ${options.output}\n`, { output: options.output, bytes: bytes.length });
    return;
  }
  ctx.io.stdout.write(bytes.toString("binary"));
}

async function syncStatus(ctx: CommandContext): Promise<void> {
  // --workspace names resolve through the account's listing; without one the
  // relay stats address the same server default the object API would.
  const workspaceId = (await ctx.client.workspaceId()) ?? DEFAULT_WORKSPACE_ID;
  const stats = await ctx.client.getJson<{ envelopeCount: number; restoreEpoch: number; maxHlc: { physical: number; logical: number } }>(
    `/api/relay/v2/stats?workspaceId=${workspaceId}`,
  );
  const stateKey = `${ctx.opts.profile ?? "default"}:${ctx.client.server}`;
  const local = serverState(ctx.statePath, stateKey);
  const cursorSeq = local.cursorSeq ?? 0;
  const machine = {
    server: ctx.client.server,
    workspaceId,
    envelopeCount: stats.envelopeCount,
    restoreEpoch: stats.restoreEpoch,
    maxHlc: stats.maxHlc,
    localCursorSeq: cursorSeq,
    behind: Math.max(0, stats.envelopeCount - cursorSeq),
  };
  emit(
    ctx,
    `server ${machine.server}: ${machine.envelopeCount} envelopes (restoreEpoch ${machine.restoreEpoch})\n` +
      `local cursor: seq ${machine.localCursorSeq} — ${machine.behind} behind\n`,
    machine,
  );
}

/** CLI release version — aligned with the server release train. */
const CLI_VERSION = "4.5.2";

/** "3.0.0-m1" → [3, 0] (major, minor) for the drift comparison. */
function versionMajorMinor(version: string): [number, number] {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  return match === null ? [0, 0] : [Number(match[1]), Number(match[2])];
}

/** True when the server version is AHEAD of the CLI (major or minor) — the
 * CLI composes server responses by field name, so a newer server can rename
 * shapes and silently degrade display output (observed: `schemaId` rename
 * after 3.0.0). Advisory only — commands keep working. */
function isVersionAhead(server: string, cli: string): boolean {
  const [sMajor, sMinor] = versionMajorMinor(server);
  const [cMajor, cMinor] = versionMajorMinor(cli);
  return sMajor > cMajor || (sMajor === cMajor && sMinor > cMinor);
}

async function doctor(ctx: CommandContext): Promise<void> {
  const report: { check: string; ok: boolean; detail: string }[] = [];
  let worst: number = EXIT.ok;

  const push = (check: string, ok: boolean, detail: string, code: number) => {
    report.push({ check, ok, detail });
    if (!ok && code > worst) worst = code;
  };

  const server = ctx.opts.server ?? process.env.NOTEES_SERVER;
  const apiKey = ctx.opts.key ?? process.env.NOTEES_API_KEY;
  push("server configured", server !== undefined && server.length > 0, server ?? "missing (--server or NOTEES_SERVER)", EXIT.usage);
  push("credential configured", apiKey !== undefined && apiKey.length > 0, apiKey !== undefined ? "present" : "missing (--key or NOTEES_API_KEY)", EXIT.usage);

  if (server !== undefined && server.length > 0) {
    try {
      const version = await ctx.client.getJson<{ name: string; version: string; protocolVersion: number }>("/api/version");
      push("server reachable", true, `${version.name} ${version.version} (protocol v${version.protocolVersion})`, EXIT.ok);
      push(
        "cli/server version drift",
        !isVersionAhead(version.version, CLI_VERSION),
        isVersionAhead(version.version, CLI_VERSION)
          ? `WARN server ${version.version} is ahead of cli ${CLI_VERSION} — rebuild the CLI (response shapes may be stale)`
          : `cli ${CLI_VERSION} in step with server ${version.version}`,
        EXIT.ok, // advisory — never fails the probe
      );
    } catch (error) {
      if (error instanceof CliError) {
        push("server reachable", false, error.message, error.exitCode);
      } else {
        push("server reachable", false, String(error), EXIT.network);
      }
    }
    if (apiKey !== undefined && apiKey.length > 0) {
      // The probe sends the credential verbatim — the server resolves
      // operator key, user API key, and session tokens alike.
      try {
        const workspaceId = (await ctx.client.workspaceId()) ?? DEFAULT_WORKSPACE_ID;
        await ctx.client.getJson<unknown>(`/api/relay/v2/stats?workspaceId=${workspaceId}`);
        push("authentication", true, "credential accepted", EXIT.ok);
      } catch (error) {
        if (error instanceof CliError) {
          push("authentication", false, error.message, error.exitCode);
        } else {
          push("authentication", false, String(error), EXIT.network);
        }
      }
    }
  }

  const lines = report.map((entry) => `${entry.ok ? "ok" : "FAIL"}  ${entry.check}: ${entry.detail}`);
  emit(ctx, `${lines.join("\n")}\n`, { ok: worst === EXIT.ok, checks: report });
  if (worst !== EXIT.ok) {
    throw new CliError(worst as 0 | 1 | 2 | 3 | 4 | 5, `doctor found failing checks (exit ${worst})`, { report });
  }
}

// --- export --------------------------------------------------------------------

/** Closure depth: depth N follows N+1 backlink hops (depth 0 = the seed's
 * direct referrers only); default 3. */
function parseDepth(options: { depth?: string; fixpoint?: boolean }): number {
  if (options.fixpoint === true) return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(options.depth ?? "3", 10);
  if (!Number.isInteger(parsed) || parsed < 0) failUsage("--depth must be a non-negative integer");
  return parsed;
}

function requireExportSelectors(command: string, options: { ids?: string[]; linkedTo?: string | undefined; classRef?: string | undefined }): string[] {
  const ids = options.ids ?? [];
  const modes = [ids.length > 0, options.linkedTo !== undefined, options.classRef !== undefined].filter(Boolean).length;
  if (modes === 0) failUsage(`${command} requires --ids <uuid...>, --linked-to <uuid>, or --class <id|title>`);
  if (modes > 1) failUsage("--ids, --linked-to, and --class are mutually exclusive");
  return ids;
}

async function exportMarkdown(ctx: CommandContext, options: {
  ids?: string[];
  linkedTo?: string;
  classRef?: string;
  depth?: string;
  fixpoint?: boolean;
  outputDir?: string;
  stdout?: boolean;
}): Promise<void> {
  const ids = requireExportSelectors("export markdown", options);
  // --class seeds the bundle with the class's current members (class: uuid
  // or title) — the natural "export this class" selector.
  let seeds = ids;
  if (options.classRef !== undefined) {
    const klass = await resolveClassRef(ctx, options.classRef);
    const detail = await ctx.client.getJson<{ members: Array<{ id: string }> }>(
      `/api/classes/${encodeURIComponent(klass.id)}`,
    );
    seeds = detail.members.map((member) => member.id);
  }
  if (options.outputDir !== undefined && options.stdout === true) {
    failUsage("--output-dir and --stdout are mutually exclusive");
  }
  if (options.outputDir === undefined && options.stdout !== true) {
    failUsage("export markdown requires --output-dir <dir> or --stdout");
  }
  const depth = parseDepth(options);
  // Seeds + closure + children + reference names live in markdown-export.ts,
  // shared with the shell's export(ids) helper.
  const bundle = await buildMarkdownBundle(ctx.client, { ids: seeds, linkedTo: options.linkedTo, depth });
  const machine = { files: bundle.files.length, nodes: bundle.manifest.nodes };
  if (options.stdout === true) {
    const text = concatBundleMarkdown(bundle);
    emit(ctx, text, { ...machine, bundle: text });
    return;
  }
  const dir = options.outputDir;
  if (dir === undefined) throw new CliError(EXIT.usage, "export markdown requires --output-dir <dir> or --stdout");
  mkdirSync(dir, { recursive: true });
  for (const file of bundle.files) writeFileSync(join(dir, file.path), file.content);
  writeFileSync(join(dir, "notees-manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`);
  emit(ctx, `wrote ${bundle.files.length} files to ${dir}\n`, machine);
}

async function exportJson(ctx: CommandContext, options: {
  ids?: string[];
  linkedTo?: string;
  classRef?: string;
  depth?: string;
  fixpoint?: boolean;
  output?: string;
}): Promise<void> {
  const ids = requireExportSelectors("export json", options);
  // --class seeds the archive with the class's current members, mirroring
  // the markdown selector.
  let seeds = ids;
  if (options.classRef !== undefined) {
    const klass = await resolveClassRef(ctx, options.classRef);
    const detail = await ctx.client.getJson<{ members: Array<{ id: string }> }>(
      `/api/classes/${encodeURIComponent(klass.id)}`,
    );
    seeds = detail.members.map((member) => member.id);
  }
  const depth = parseDepth(options);
  const archive = await buildJsonArchiveDocument(ctx.client, {
    ids: seeds,
    linkedTo: options.linkedTo,
    depth,
  });
  const text = renderJsonArchive(archive);
  const machine = { format: archive.format, version: archive.version, nodes: archive.nodes.length };
  if (options.output !== undefined) {
    writeFileSync(options.output, text, "utf8");
    emit(ctx, `wrote ${archive.nodes.length} nodes to ${options.output}\n`, machine);
    return;
  }
  emit(ctx, text, machine);
}

// --- bibliography round-trip (BibTeX import/export) -------------------------------

interface FullApiProperty {
  schemaId: string;
  schemaName: string;
  value: unknown;
  idx?: number;
}

interface FullApiObject {
  id: string;
  name: string | null;
  classIds: string[];
  properties?: FullApiProperty[];
}

function fullPropertiesOf(object: unknown): FullApiProperty[] {
  const properties = (object as FullApiObject | undefined)?.properties;
  return Array.isArray(properties) ? properties : [];
}

async function getFullObject(ctx: CommandContext, id: string): Promise<FullApiObject> {
  const body = await ctx.client.getJson<{ object: FullApiObject }>(
    `/api/objects/${encodeURIComponent(id)}`,
  );
  return body.object;
}

async function setProperty(
  ctx: CommandContext,
  objectId: string,
  propertySchemaId: string,
  value: unknown,
  idx = 0,
): Promise<void> {
  await ctx.client.postJson(`/api/objects/${encodeURIComponent(objectId)}/properties`, {
    propertySchemaId,
    value,
    idx,
  });
}

const PROPERTY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Property schema argument: a uuid is used verbatim; anything else resolves
 * against the workspace's schema list by (case-insensitive) name. */
async function resolvePropertySchemaRef(
  ctx: CommandContext,
  ref: string,
): Promise<{ id: string; name: string }> {
  if (PROPERTY_UUID_PATTERN.test(ref)) return { id: ref, name: ref };
  const body = await ctx.client.getJson<{ propertySchemas: { id: string; name: string }[] }>(
    "/api/property-schemas",
  );
  const wanted = ref.trim().toLowerCase();
  const matches = body.propertySchemas.filter((schema) => schema.name.toLowerCase() === wanted);
  if (matches.length === 0) failUsage(`no property schema named "${ref}" (pass a schema id, or one of the listed names)`);
  if (matches.length > 1) failUsage(`property schema name "${ref}" is ambiguous — pass a schema id`);
  return matches[0]!;
}

/** `notees object property set` — value parses as JSON when it can (numbers,
 * booleans, {nodeId} refs for node-typed schemas), else stays a plain string. */
async function objectPropertySet(
  ctx: CommandContext,
  id: string,
  schemaRef: string,
  value: string,
  options: { idx?: string },
): Promise<void> {
  const schema = await resolvePropertySchemaRef(ctx, schemaRef);
  const idx = Number.parseInt(options.idx ?? "0", 10);
  if (!Number.isInteger(idx) || idx < 0) failUsage("--idx must be a non-negative integer");
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    // Plain string value — the common case for text-ish schemas.
  }
  await setProperty(ctx, id, schema.id, parsed, idx);
  const body = await ctx.client.getJson<{ object: unknown }>(`/api/objects/${encodeURIComponent(id)}`);
  emit(ctx, `${JSON.stringify(body.object, null, 2)}\n`, { objectId: id, schemaId: schema.id, schemaName: schema.name, idx, object: body.object });
}

/** `notees object property delete` — unsets one slot (idx) of a schema's value. */
async function objectPropertyDelete(
  ctx: CommandContext,
  id: string,
  schemaRef: string,
  options: { idx?: string },
): Promise<void> {
  const schema = await resolvePropertySchemaRef(ctx, schemaRef);
  const idx = Number.parseInt(options.idx ?? "0", 10);
  if (!Number.isInteger(idx) || idx < 0) failUsage("--idx must be a non-negative integer");
  await deleteProperty(ctx, id, schema.id, idx);
  const body = await ctx.client.getJson<{ object: unknown }>(`/api/objects/${encodeURIComponent(id)}`);
  emit(ctx, `${JSON.stringify(body.object, null, 2)}\n`, { objectId: id, schemaId: schema.id, schemaName: schema.name, idx, object: body.object });
}

// --- covers --------------------------------------------------------------------

/**
 * The cover is a wire node field: `object.update`'s optional nullable
 * `coverAssetId` (SCHEMA.md "Node structure") — present writes, present-null
 * clears, exactly like `color`. The retired image-typed `cover` property
 * schema was superseded by the field and is never re-authored here. The
 * cover target is an ordinary asset-classed node; the `asset` class root is
 * seeded by the server on workspace bootstrap (SEEDED_SYSTEM_CLASSES), so no
 * family ensure is needed.
 */
const ASSET_CLASS_ID = SYSTEM_CLASS_UUIDS.asset;

interface FullObject {
  id: string;
  /** Wire node fields (null = unset) — exposed on every object projection. */
  coverAssetId?: string | null;
  bannerAssetId?: string | null;
  aliasedNodeId?: string | null;
  properties?: Array<{ schemaId: string; idx?: number; value: unknown }>;
  classIds?: string[];
  [key: string]: unknown;
}

async function getObject(ctx: CommandContext, id: string): Promise<FullObject> {
  const body = await ctx.client.getJson<{ object: FullObject }>(`/api/objects/${encodeURIComponent(id)}`);
  return body.object;
}

/** The cover's asset node id on a node (null = no cover). */
function coverAssetOf(object: FullObject): string | null {
  return object.coverAssetId ?? null;
}

async function coverSetField(ctx: CommandContext, nodeId: string, coverAssetId: string | null): Promise<void> {
  await ctx.client.patchJson(`/api/objects/${encodeURIComponent(nodeId)}`, { coverAssetId });
}

/**
 * `notees cover set <nodeId> <file>` / `--asset <assetNodeId>` — the one-gesture
 * cover: (file: asset node + upload/attach | --asset: reuse a node) →
 * `coverAssetId` on the node. Replaces an existing cover by default (the old
 * asset node survives as an asset); --skip-existing makes scripts re-runnable
 * (prints the existing asset id, no writes).
 */
async function coverSet(
  ctx: CommandContext,
  nodeId: string,
  file: string | undefined,
  options: { asset?: string; skipExisting?: boolean },
): Promise<void> {
  const fromFile = file !== undefined;
  const fromAsset = options.asset !== undefined;
  if (fromFile === fromAsset) failUsage("cover set takes exactly one of <file> or --asset <assetNodeId>");
  const object = await getObject(ctx, nodeId);

  const existing = coverAssetOf(object);
  if (existing !== null && options.skipExisting === true) {
    emit(ctx, `${existing}\n`, { pageId: nodeId, assetId: existing, created: false, replaced: false });
    return;
  }
  let replaced: string | null = null;
  if (existing !== null) {
    replaced = existing;
    await coverSetField(ctx, nodeId, null);
  }

  let assetId: string;
  if (fromAsset) {
    assetId = options.asset!;
    const assetNode = await getObject(ctx, assetId);
    const classes = assetNode.classIds ?? [];
    if (!classes.includes(ASSET_CLASS_ID)) {
      await ctx.client.putJson(`/api/objects/${encodeURIComponent(assetId)}/classes/${encodeURIComponent(ASSET_CLASS_ID)}`);
    }
  } else {
    const created = await ctx.client.postJson<{ id: string }>("/api/objects", {
      name: basename(file!),
      isEmbedded: false,
      classIds: [ASSET_CLASS_ID],
    });
    assetId = created.id;
    await uploadAsset(ctx, file!, assetId);
  }
  await coverSetField(ctx, nodeId, assetId);
  emit(ctx, `${assetId}\n`, { pageId: nodeId, assetId, created: true, replaced });
}

/** `notees cover get <nodeId>` — resolve the cover to its asset node id. */
async function coverGet(ctx: CommandContext, nodeId: string): Promise<void> {
  const object = await getObject(ctx, nodeId);
  const assetId = coverAssetOf(object);
  if (assetId === null) failUsage("node has no cover");
  let asset: FullObject | null = null;
  try {
    asset = await getObject(ctx, assetId);
  } catch {
    asset = null; // dangling reference — report the id, flag the asset.
  }
  emit(
    ctx,
    `${assetId}\n`,
    { pageId: nodeId, assetId, asset: asset === null ? null : { id: asset.id, name: asset.name ?? null } },
  );
}

/** `notees cover clear <nodeId>` — unset the cover; the asset node survives
 * (it stays an ordinary asset). */
async function coverClear(ctx: CommandContext, nodeId: string): Promise<void> {
  const object = await getObject(ctx, nodeId);
  const cleared = coverAssetOf(object);
  if (cleared === null) failUsage("node has no cover");
  await coverSetField(ctx, nodeId, null);
  emit(ctx, `${cleared}\n`, { pageId: nodeId, cleared: true, assetId: cleared });
}

async function deleteProperty(
  ctx: CommandContext,
  objectId: string,
  propertySchemaId: string,
  idx = 0,
): Promise<void> {
  await ctx.client.deleteJson(
    `/api/objects/${encodeURIComponent(objectId)}/properties/${encodeURIComponent(propertySchemaId)}?idx=${idx}`,
  );
}

// --- property schema verbs -----------------------------------------------------

const PROPERTY_TYPES = [
  "text",
  "number",
  "boolean",
  "datetime",
  "url",
  "email",
  "select",
  "multi_select",
  "object",
  "image",
] as const;

interface ApiPropertySchema {
  id: string;
  name: string;
  type: string;
  multi: boolean;
  icon: string | null;
  /** The sole locality authority (the retired `scope` enum is gone): null =
   * global (any node may carry it); a non-empty class-id list = local to those
   * classes and their extends-ancestors. */
  scopeClassIds: string[] | null;
  options: Array<{ id: string; label: string }> | null;
  targetClassFilter: string[] | null;
  datePrecision: string | null;
  dateQualified: boolean | null;
}

async function propertyList(ctx: CommandContext): Promise<void> {
  const body = await ctx.client.getJson<{ propertySchemas: ApiPropertySchema[] }>("/api/property-schemas");
  // Resolve locality class ids to names for the human table (one listing
  // call; ids with no live class row fall back to the raw id).
  const scopedIds = [...new Set(body.propertySchemas.flatMap((schema) => schema.scopeClassIds ?? []))];
  const classNames = new Map<string, string>();
  if (scopedIds.length > 0) {
    const listing = await ctx.client.getJson<{ classes: Array<{ id: string; name: string }> }>("/api/classes");
    for (const klass of listing.classes) classNames.set(klass.id, klass.name);
  }
  const rows = body.propertySchemas.map((schema) => [
    schema.name,
    schema.type,
    schema.multi ? "multi" : "",
    schema.scopeClassIds === null
      ? "global"
      : schema.scopeClassIds.map((id) => classNames.get(id) ?? id).join(", "),
    schema.id,
  ]);
  emit(ctx, `${formatTable([["NAME", "TYPE", "MULTI", "SCOPE", "ID"], ...rows])}\n`, body);
}

async function propertyGet(ctx: CommandContext, schemaRef: string): Promise<void> {
  const schema = await resolvePropertySchemaRef(ctx, schemaRef);
  const body = await ctx.client.getJson<{ propertySchema: ApiPropertySchema }>(
    `/api/property-schemas/${encodeURIComponent(schema.id)}`,
  );
  const eligibleClasses = await resolveEligibleClasses(ctx, body.propertySchema);
  emit(
    ctx,
    `${JSON.stringify({ ...body.propertySchema, eligibleClasses }, null, 2)}\n`,
    { ...body, eligibleClasses },
  );
}

/**
 * Client-side eligibility resolution for `property get`: scope is the sole
 * locality authority — `scopeClassIds: null` means global (every node), a
 * non-empty list means the scoped classes plus every class whose transitive
 * extends-closure reaches one. `via` is the shortest parent-chain from the
 * class up to a scoped class as readable names, or `["(scoped directly)"]`
 * when the class itself is in scope.
 */
async function resolveEligibleClasses(
  ctx: CommandContext,
  schema: ApiPropertySchema,
): Promise<Array<{ id: string; name: string; via: string[] }> | null> {
  if (schema.scopeClassIds === null) return null;
  const scoped = new Set(schema.scopeClassIds);
  const { classes } = await ctx.client.getJson<{ classes: ApiClassRow[] }>("/api/classes");
  const byId = new Map(classes.map((klass) => [klass.id, klass]));
  const eligible: Array<{ id: string; name: string; via: string[] }> = [];
  for (const klass of classes) {
    if (scoped.has(klass.id)) {
      eligible.push({ id: klass.id, name: klass.name, via: ["(scoped directly)"] });
      continue;
    }
    // BFS upward (extends may fan out) — the first scoped ancestor hit is the
    // shortest chain; the visited set guards against extends cycles.
    const visited = new Set<string>([klass.id]);
    let frontier: Array<{ id: string; chain: string[] }> = (klass.parentClassIds ?? []).map((parentId) => ({
      id: parentId,
      chain: [parentId],
    }));
    let via: string[] | null = null;
    while (frontier.length > 0) {
      const next: Array<{ id: string; chain: string[] }> = [];
      for (const step of frontier) {
        if (visited.has(step.id)) continue;
        visited.add(step.id);
        if (scoped.has(step.id)) {
          via = step.chain;
          break;
        }
        for (const parentId of byId.get(step.id)?.parentClassIds ?? []) {
          next.push({ id: parentId, chain: [...step.chain, parentId] });
        }
      }
      if (via !== null) break;
      frontier = next;
    }
    if (via !== null) {
      eligible.push({
        id: klass.id,
        name: klass.name,
        via: [klass.id, ...via].map((id) => displayClassName(byId.get(id)?.name ?? id)),
      });
    }
  }
  return eligible.sort((a, b) => displayClassName(a.name).localeCompare(displayClassName(b.name)));
}

/** `notees property create` — the server stamps the envelope; the schema id is
 * caller-chosen (UUIDv7 here, so a retry with the same args never collides
 * with a live schema). Option ids derive deterministically from the schema id
 * + label (idempotent re-runs land on the same option ids). */
async function propertyCreate(
  ctx: CommandContext,
  name: string,
  options: {
    type?: string;
    multi?: boolean;
    option?: string[];
    targetClass?: string[];
    pad?: string;
    decimals?: string;
    rounding?: string;
    default?: string;
  },
): Promise<void> {
  const type = options.type ?? "text";
  if (!(PROPERTY_TYPES as readonly string[]).includes(type)) {
    failUsage(`unknown property type "${type}" — one of: ${PROPERTY_TYPES.join(", ")}`);
  }
  const formats = options.pad !== undefined || options.decimals !== undefined || options.rounding !== undefined;
  if (formats && type !== "number") {
    failUsage("number formatting flags (--pad/--decimals/--rounding) require --type number");
  }
  const parseIntFlag = (label: string, raw: string | undefined, min: number, max: number): number | undefined => {
    if (raw === undefined) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) failUsage(`${label} must be an integer ${min}–${max}`);
    return parsed;
  };
  const numberPad = parseIntFlag("--pad", options.pad, 1, 20);
  const numberDecimals = parseIntFlag("--decimals", options.decimals, 0, 10);
  const numberRounding = options.rounding as "round" | "floor" | "ceil" | "truncate" | undefined;
  if (options.rounding !== undefined && !["round", "floor", "ceil", "truncate"].includes(options.rounding)) {
    failUsage("--rounding must be one of: round, floor, ceil, truncate");
  }
  let defaultValue: unknown;
  if (options.default !== undefined) {
    try {
      defaultValue = JSON.parse(options.default) as unknown;
    } catch {
      failUsage("--default must be valid JSON (e.g. --default '\"n/a\"' or --default '42')");
    }
  }
  const propertySchemaId = uuidv7();
  const targetClassFilter: string[] = [];
  for (const ref of options.targetClass ?? []) {
    targetClassFilter.push((await resolveClassRef(ctx, ref)).id);
  }
  const body = await ctx.client.postJson<{ propertySchema: ApiPropertySchema }>("/api/property-schemas", {
    propertySchemaId,
    name,
    type,
    multi: options.multi === true,
    ...(options.option !== undefined && options.option.length > 0
      ? {
          options: options.option.map((label) => ({
            id: deriveUuid(`notees:property-option:${propertySchemaId}:${label}`),
            label,
          })),
        }
      : {}),
    ...(targetClassFilter.length > 0 ? { targetClassFilter } : {}),
    ...(numberPad !== undefined ? { numberPad } : {}),
    ...(numberDecimals !== undefined ? { numberDecimals } : {}),
    ...(numberRounding !== undefined ? { numberRounding } : {}),
    ...(options.default !== undefined ? { defaultValue } : {}),
  });
  emit(ctx, `${body.propertySchema.id}\n`, body);
}

async function propertyRename(ctx: CommandContext, schemaRef: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === "") failUsage("property rename: new name must not be empty");
  const schema = await resolvePropertySchemaRef(ctx, schemaRef);
  const body = await ctx.client.patchJson<{ propertySchema: ApiPropertySchema }>(
    `/api/property-schemas/${encodeURIComponent(schema.id)}`,
    { name: trimmed },
  );
  emit(ctx, `${JSON.stringify(body.propertySchema, null, 2)}\n`, body);
}

/** `notees property delete` — soft-delete (authored values survive; the same
 * UUID can be recreated later, the delete+recreate path the register blesses
 * pending PG3). Preview-first like the other destructive verbs. */
async function propertyDelete(
  ctx: CommandContext,
  schemaRef: string,
  options: { yes?: boolean },
): Promise<void> {
  const schema = await resolvePropertySchemaRef(ctx, schemaRef);
  if (options.yes !== true) {
    ctx.io.stderr.write(
      `Refusing to delete property schema "${schema.name}": authored values survive, but every binding and the schema row go inactive.\nRe-run with --yes to proceed.\n`,
    );
    throw new CliError(EXIT.usage, "destructive command requires --yes", { schemaId: schema.id });
  }
  await ctx.client.deleteJson(`/api/property-schemas/${encodeURIComponent(schema.id)}`);
  emit(ctx, `deleted ${schema.id}\n`, { id: schema.id, deleted: true });
}

/** `notees property bind` — the class.property.set upsert. The binding is
 * presence-only since the property-definition batch: `sequence`, `required`,
 * and `defaultValue` retired from the binding (the strict schema rejects
 * them), and the one global default moved to the property schema
 * (`property create --default`) — class properties render as a pure
 * alphabetical list by property name. The endpoint requires at least one
 * binding field, so a bind writes `active: true`. */
async function propertyBind(
  ctx: CommandContext,
  classRef: string,
  schemaRef: string,
): Promise<void> {
  const klass = await resolveClassRef(ctx, classRef);
  const schema = await resolvePropertySchemaRef(ctx, schemaRef);
  const res = await ctx.client.postJson<{ binding: unknown }>(
    `/api/classes/${encodeURIComponent(klass.id)}/properties`,
    { propertySchemaId: schema.id, active: true },
  );
  emit(ctx, `${JSON.stringify(res.binding, null, 2)}\n`, { classId: klass.id, ...res });
}

async function propertyUnbind(ctx: CommandContext, classRef: string, schemaRef: string): Promise<void> {
  const klass = await resolveClassRef(ctx, classRef);
  const schema = await resolvePropertySchemaRef(ctx, schemaRef);
  const res = await ctx.client.deleteJson<{ unbound: boolean }>(
    `/api/classes/${encodeURIComponent(klass.id)}/properties/${encodeURIComponent(schema.id)}`,
  );
  emit(ctx, `unbound ${schema.name} from ${klass.name}\n`, { classId: klass.id, schemaId: schema.id, ...res });
}

/**
 * Get-or-create a property schema by its fixed system UUID (all replicas
 * converge on the same ids). Seeded workspaces already carry the
 * bibliographic schemas, so the create path only fires for unseeded ones.
 *
 * Drift note (no migration): workspaces seeded during the brief
 * 2026-09-27 text-authors window carry `authors` as text-multi from that
 * seed spec. The fixed UUID matches, so this get-or-create is a no-op
 * there and the stored row keeps its old type (throwaway data).
 */
async function ensurePropertySchema(ctx: CommandContext, name: SystemPropertyName): Promise<void> {
  const propertySchemaId = SYSTEM_PROPERTY_UUIDS[name];
  try {
    await ctx.client.getJson(`/api/property-schemas/${propertySchemaId}`);
    return;
  } catch (error) {
    if (!(error instanceof CliError) || error.exitCode !== EXIT.domain) throw error;
  }
  const spec = SYSTEM_PROPERTY_SPECS[name];
  if (spec === undefined) throw new CliError(EXIT.domain, `no system spec for property schema "${name}"`);
  await ctx.client.postJson("/api/property-schemas", {
    propertySchemaId,
    name,
    type: spec.type,
    multi: spec.multi ?? false,
    ...(spec.options !== undefined ? { options: spec.options } : {}),
    ...(spec.targetClassFilter !== undefined
      ? { targetClassFilter: spec.targetClassFilter.map((className: SystemClassName) => SYSTEM_CLASS_UUIDS[className]) }
      : {}),
  });
}

// --- source imports (bibtex / csl-json / zotero-rdf) -----------------------------

interface SourceImportOptions {
  dryRun?: boolean;
  /** Match-only mode (the --no-create flag): apply updates/adoptions, skip entries that would create a source. */
  create?: boolean;
}

interface SourceImportCounts {
  created: number;
  updated: number;
  /** Title-matched nodes adopted into the bibliography (renamed + citekey set). */
  adopted: number;
  /** Entries not imported (match-only mode + unkeyed top-level RDF items). */
  skipped: number;
  /** Extra nodes sharing an adopted title (adopted the first, counted the rest). */
  ambiguous: number;
  persons: number;
  personsCreated: number;
}

interface ImportEntryPlan {
  citekey: string | null;
  action: "create" | "update" | "adopt" | "skip";
  nodeId?: string;
  title: string;
  persons: Array<{ literal: string; action: "existing" | "create"; nodeId?: string }>;
  /** Class the adoption would assign (eligibility repair) — absent when not needed. */
  classAssign?: string;
}

function readImportFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    throw new CliError(EXIT.usage, `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The property schemas an import may touch (citekey always; the rest only when used). */
function usedSchemaNames(items: CslItem[]): Set<SystemPropertyName> {
  const used = new Set<SystemPropertyName>(["citekey"]);
  for (const item of items) {
    if (item.DOI !== undefined) used.add("doi");
    if (item.ISBN !== undefined) used.add("isbn");
    if (item.URL !== undefined) used.add("url");
    if (item.publisher !== undefined) used.add("publisher");
    if (item.issued !== undefined) used.add("publicationDate");
    if ((item.author ?? []).length > 0) used.add("authors");
    if ((item.editor ?? []).length > 0) used.add("editors");
  }
  return used;
}

async function importBibtex(ctx: CommandContext, filePath: string, options: SourceImportOptions): Promise<void> {
  const entries = parseBibtex(readImportFile(filePath));
  await runSourceImport(ctx, "bibtex", filePath, entries.map(bibToCsl), 0, options);
}

async function importCslJson(ctx: CommandContext, filePath: string, options: SourceImportOptions): Promise<void> {
  const items = parseCslJson(readImportFile(filePath), (message) => {
    throw new CliError(EXIT.usage, `cannot import ${filePath}: ${message}`);
  });
  await runSourceImport(ctx, "csl-json", filePath, items, 0, options);
}

async function importZoteroRdf(ctx: CommandContext, filePath: string, options: SourceImportOptions): Promise<void> {
  let result: ZoteroRdfParseResult;
  try {
    result = parseZoteroRdf(readImportFile(filePath));
  } catch (error) {
    throw new CliError(
      EXIT.usage,
      `cannot import ${filePath}: not well-formed Zotero RDF (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  await runSourceImport(ctx, "zotero-rdf", filePath, result.items, result.skipped, options);
}

/**
 * The shared source-import pipeline: schema ensure → authors find-or-create →
 * source upsert/adopt → field writes. All three formats feed it as CslItem[].
 *
 * Lookup order per entry: (a) citekey-property match (authoritative);
 * (b) exact node-title match on `citekey` / `@citekey` — adoption renames the
 * node to the spec title, sets the Citekey property, repairs eligibility with
 * the spec's source class when the node's class closure misses the citekey
 * schema's scope, then takes the normal update path. `--dry-run` runs the
 * whole match/plan phase and writes nothing (schemas included); `--no-create`
 * skips would-create entries (match-only mode).
 */
async function runSourceImport(
  ctx: CommandContext,
  format: "bibtex" | "csl-json" | "zotero-rdf",
  filePath: string,
  items: CslItem[],
  parserSkipped: number,
  options: SourceImportOptions,
): Promise<void> {
  if (items.length === 0) {
    throw new CliError(EXIT.domain, `no importable entries found in ${filePath}`);
  }
  const dryRun = options.dryRun === true;
  const specs = items.map(cslToNodeSpecs);

  // Schema ensure — part of the plan under --dry-run (write nothing).
  const schemaPlan: Array<{ name: SystemPropertyName; status: "present" | "ensured" | "would-ensure" }> = [];
  for (const name of usedSchemaNames(items)) {
    if (!dryRun) {
      await ensurePropertySchema(ctx, name);
      schemaPlan.push({ name, status: "ensured" });
      continue;
    }
    try {
      await ctx.client.getJson(`/api/property-schemas/${SYSTEM_PROPERTY_UUIDS[name]}`);
      schemaPlan.push({ name, status: "present" });
    } catch {
      schemaPlan.push({ name, status: "would-ensure" });
    }
  }

  // Adoption eligibility: the citekey schema's scope decides which class
  // closures may carry it (resolveEligibleClasses is the Slice-B helper,
  // lifted to module scope for exactly this reuse).
  const citekeySchema = await ctx.client.getJson<{ propertySchema: ApiPropertySchema }>(
    `/api/property-schemas/${SYSTEM_PROPERTY_UUIDS.citekey}`,
  );
  const eligible = await resolveEligibleClasses(ctx, citekeySchema.propertySchema);
  const eligibleIds = eligible === null ? null : new Set(eligible.map((entry) => entry.id));

  const counts: SourceImportCounts = {
    created: 0,
    updated: 0,
    adopted: 0,
    skipped: parserSkipped,
    ambiguous: 0,
    persons: 0,
    personsCreated: 0,
  };
  const personIds = new Map<string, string>(); // per-run dedupe (real mode)
  const personPlans = new Map<string, ImportEntryPlan["persons"][number]>(); // per-run dedupe (plan mode)
  const importedIds: string[] = [];
  const skippedEntries: Array<{ citekey: string | null; title: string }> = [];
  const plans: ImportEntryPlan[] = [];

  for (const spec of specs) {
    // (a) citekey-property match stays authoritative; (b) title match adopts.
    const existing = await findSourceByCitekey(ctx, spec.citekey);
    let matched = existing;
    let action: "create" | "update" | "adopt";
    if (existing !== undefined) {
      action = "update";
    } else {
      const titleMatches = await findSourcesByTitle(ctx, spec.citekey);
      if (titleMatches.length > 0) {
        matched = titleMatches[0];
        action = "adopt";
        counts.ambiguous += titleMatches.length - 1;
      } else {
        action = "create";
      }
    }

    if (action === "create" && options.create === false) {
      counts.skipped += 1;
      skippedEntries.push({ citekey: spec.citekey, title: spec.title });
      plans.push({ citekey: spec.citekey, action: "skip", title: spec.title, persons: [] });
      continue;
    }

    // Authors: dual-track (SCHEMA.md "Citations") — the
    // persons are still find-or-created (one per name string; the
    // linkedAuthors people-graph track), and the same literals land on the
    // free-text `authors` citation track in upsertSource. Dry-run resolves
    // without creating and reports the plan.
    const authorIds: string[] = [];
    const entryPersons: ImportEntryPlan["persons"] = [];
    for (const literal of spec.authors) {
      if (literal.length === 0) continue;
      if (dryRun) {
        let plan = personPlans.get(literal);
        if (plan === undefined) {
          const personId = await findPersonByName(ctx, literal);
          plan =
            personId !== undefined
              ? { literal, action: "existing", nodeId: personId }
              : { literal, action: "create" };
          personPlans.set(literal, plan);
          counts.persons += 1;
          if (plan.action === "create") counts.personsCreated += 1;
        }
        entryPersons.push(plan);
        continue;
      }
      let personId = personIds.get(literal);
      if (personId === undefined) {
        personId = await findOrCreatePerson(ctx, literal, counts);
        personIds.set(literal, personId);
        counts.persons += 1;
      }
      authorIds.push(personId);
    }

    const needsClassAssign =
      action === "adopt" &&
      eligibleIds !== null &&
      matched !== undefined &&
      !matched.classIds.some((classId) => eligibleIds.has(classId));

    if (dryRun) {
      plans.push({
        citekey: spec.citekey,
        action,
        ...(matched !== undefined ? { nodeId: matched.id } : {}),
        title: spec.title,
        persons: entryPersons,
        ...(needsClassAssign ? { classAssign: spec.className } : {}),
      });
      if (action === "create") counts.created += 1;
      else if (action === "adopt") counts.adopted += 1;
      else counts.updated += 1;
      continue;
    }

    const id = await upsertSource(ctx, spec, authorIds, counts, action, matched, needsClassAssign);
    importedIds.push(id);
  }

  if (dryRun) {
    const summary =
      `${counts.created} create, ${counts.updated} update, ${counts.adopted} adopt, ` +
      `${counts.skipped} skip (${counts.ambiguous} ambiguous title collisions)`;
    const rows = plans.map((plan) => [
      plan.citekey ?? "(unkeyed)",
      plan.action,
      plan.nodeId ?? "",
      plan.title,
      ...(plans.some((p) => p.classAssign !== undefined) ? [plan.classAssign ?? ""] : []),
    ]);
    const headers = ["CITEKEY", "ACTION", "NODE", "TITLE"];
    if (plans.some((p) => p.classAssign !== undefined)) headers.push("CLASS ASSIGN");
    const wouldEnsure = schemaPlan.filter((s) => s.status === "would-ensure").map((s) => s.name);
    const personNew = plans.flatMap((p) => p.persons).filter((p) => p.action === "create").length;
    emit(
      ctx,
      `dry run (${format}, ${filePath}) — no writes\n` +
        `${formatTable([headers, ...rows])}\n` +
        `persons: ${counts.persons} planned (${personNew} would be created)\n` +
        `schemas: ${schemaPlan.map((s) => s.name).join(", ")}` +
        (wouldEnsure.length > 0 ? ` (${wouldEnsure.join(", ")} would be ensured)` : " (all present)") +
        `\nplanned: ${plans.length} entries — ${summary}\n`,
      { dryRun: true, format, filePath, schemas: schemaPlan, entries: plans, counts },
    );
    return;
  }

  const machine: Record<string, unknown> = { ...counts, entries: importedIds };
  if (skippedEntries.length > 0) machine.skippedEntries = skippedEntries;
  emit(
    ctx,
    `imported ${importedIds.length} entries: ${counts.created} created, ${counts.updated} updated, ` +
      `${counts.adopted} adopted, ${counts.skipped} skipped, ${counts.ambiguous} ambiguous, ` +
      `${counts.persons} persons (${counts.personsCreated} new)\n`,
    machine,
  );
}

/**
 * Title-match lookup for adoption: exact node-title equality on `citekey` or
 * `@citekey` after trim (these strings are distinctive — substring matching
 * would be wrong). The objects?q= full-text search narrows the candidate set;
 * the exact filter is the authority.
 */
async function findSourcesByTitle(ctx: CommandContext, citekey: string): Promise<FullApiObject[]> {
  const body = await ctx.client.getJson<{ objects: FullApiObject[] }>(`/api/objects${queryString({ q: citekey })}`);
  const seen = new Set<string>();
  const matches: FullApiObject[] = [];
  for (const object of body.objects) {
    const name = object.name?.trim();
    if (name !== citekey && name !== `@${citekey}`) continue;
    if (seen.has(object.id)) continue;
    seen.add(object.id);
    matches.push(object);
  }
  return matches;
}

async function upsertSource(
  ctx: CommandContext,
  spec: ReturnType<typeof cslToNodeSpecs>,
  authorIds: string[],
  counts: SourceImportCounts,
  action: "create" | "update" | "adopt",
  matched: FullApiObject | undefined,
  needsClassAssign: boolean,
): Promise<string> {
  let id: string;
  if (action === "create") {
    const created = await ctx.client.postJson<{ id: string }>("/api/objects", {
      isEmbedded: false,
      name: spec.title,
      classIds: [SYSTEM_CLASS_UUIDS[spec.className]],
    });
    id = created.id;
    counts.created += 1;
  } else {
    id = matched!.id;
    if (action === "adopt") {
      counts.adopted += 1;
      // Eligibility repair: the node's class closure misses the citekey
      // scope — assign the spec's source class first (the write would fail
      // loud otherwise).
      if (needsClassAssign) {
        await ctx.client.putJson(`/api/objects/${encodeURIComponent(id)}/classes/${encodeURIComponent(SYSTEM_CLASS_UUIDS[spec.className])}`);
      }
    } else {
      counts.updated += 1;
    }
    if (matched!.name !== spec.title) {
      // Title-is-content: the title update rewrites the node's text content.
      await ctx.client.patchJson(`/api/objects/${encodeURIComponent(id)}`, {
        contentAst: [{ type: "text", text: spec.title }],
      });
    }
  }
  const properties = matched === undefined ? [] : fullPropertiesOf(matched);
  const setIfChanged = async (schemaId: string, value: unknown): Promise<void> => {
    const current = properties.find((p) => p.schemaId === schemaId && (p.idx ?? 0) === 0)?.value;
    if (JSON.stringify(current ?? null) === JSON.stringify(value)) return;
    await setProperty(ctx, id, schemaId, value);
  };
  await setIfChanged(SYSTEM_PROPERTY_UUIDS.citekey, spec.citekey);
  if (spec.doi !== undefined) await setIfChanged(SYSTEM_PROPERTY_UUIDS.doi, spec.doi);
  if (spec.isbn !== undefined) await setIfChanged(SYSTEM_PROPERTY_UUIDS.isbn, spec.isbn);
  if (spec.url !== undefined) await setIfChanged(SYSTEM_PROPERTY_UUIDS.url, spec.url);
  if (spec.publisher !== undefined) await setIfChanged(SYSTEM_PROPERTY_UUIDS.publisher, spec.publisher);
  if (spec.publicationDate !== undefined) {
    // Date-chain ref, not a bare string: the year node
    // backlinks everything dated that year. The year node's id is
    // content-addressed (deterministic), so ensure-then-link is idempotent.
    const year = yearFromDate(spec.publicationDate);
    if (year !== undefined) {
      const yearId = dateNodeId(`${year}-01-01`, "year");
      await ensureYearNode(ctx, yearId, String(year));
      await setIfChanged(SYSTEM_PROPERTY_UUIDS.publicationDate, { nodeId: yearId });
    } else {
      await setIfChanged(SYSTEM_PROPERTY_UUIDS.publicationDate, spec.publicationDate);
    }
  }
  // Authorship is dual-track (SCHEMA.md "Citations"):
  // `authors` carries the "Family, Given" text literals (the citation track
  // export reads first); `linkedAuthors` carries the {nodeId} refs to the
  // find-or-created agent nodes (the people-graph track). Both lists are
  // replaced wholesale — set the new values, unset the stale tail.
  const replaceList = async (
    schemaId: string,
    values: unknown[],
  ): Promise<void> => {
    const previousCount = properties.filter((p) => p.schemaId === schemaId).length;
    for (let idx = 0; idx < values.length; idx += 1) {
      await setProperty(ctx, id, schemaId, values[idx], idx);
    }
    for (let idx = values.length; idx < previousCount; idx += 1) {
      await deleteProperty(ctx, id, schemaId, idx);
    }
  };
  await replaceList(
    SYSTEM_PROPERTY_UUIDS.authors,
    spec.authors.filter((literal) => literal.length > 0),
  );
  await replaceList(
    SYSTEM_PROPERTY_UUIDS.linkedAuthors,
    authorIds.map((personId) => ({ nodeId: personId })),
  );
  if (spec.editors !== undefined) {
    await replaceList(
      SYSTEM_PROPERTY_UUIDS.editors,
      spec.editors.filter((literal) => literal.length > 0),
    );
  }
  return id;
}

/** Person match: exact display name via the objects?q= title search. */
async function findPersonByName(ctx: CommandContext, literal: string): Promise<string | undefined> {
  const query = queryString({ q: literal });
  const body = await ctx.client.getJson<{ objects: FullApiObject[] }>(`/api/objects${query}`);
  return body.objects.find(
    (object) =>
      object.name === literal &&
      (object.classIds.includes(SYSTEM_CLASS_UUIDS.person) ||
        object.classIds.includes(SYSTEM_CLASS_UUIDS.agent)),
  )?.id;
}

/** Local midnight ISO (the CLI is a local client — never UTC). */
function todayIsoLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Ensure a date-chain node exists (content-addressed id). GET-then-create —
 *  the deterministic id makes the race converge on the loser's 409, which we
 *  treat as "already there". */
async function ensureChainNode(
  ctx: CommandContext,
  id: string,
  label: string,
  classId: string,
  parentId: string | null,
): Promise<void> {
  try {
    await ctx.client.getJson(`/api/objects/${encodeURIComponent(id)}`);
    return;
  } catch {
    // Missing — create below.
  }
  try {
    await ctx.client.postJson("/api/objects", {
      id,
      isEmbedded: false,
      ...(parentId !== null ? { parentId } : {}),
      classIds: [classId],
      name: label,
    });
  } catch {
    // 409: another writer created it — the chain node exists either way.
  }
}

/** Ensure a year node exists (content-addressed id; the date chain's root). */
async function ensureYearNode(ctx: CommandContext, yearId: string, label: string): Promise<void> {
  await ensureChainNode(ctx, yearId, label, SYSTEM_CLASS_UUIDS.year, null);
}

/** `notees today`: ensure the local date chain + the day page,
 *  print the day object; --append adds a text block to it and reports
 *  the created block's id (human line / `appendedBlock` in --json). */
async function today(ctx: CommandContext, options: { append?: string }): Promise<void> {
  const iso = todayIsoLocal();
  const parts = parseIsoDate(iso);
  const ids = chainNodeIds(iso);
  await ensureChainNode(ctx, ids.year, dateNodeLabel(parts, "year"), SYSTEM_CLASS_UUIDS.year, null);
  await ensureChainNode(ctx, ids.month, dateNodeLabel(parts, "month"), SYSTEM_CLASS_UUIDS.month, ids.year);
  await ensureChainNode(ctx, ids.day, dateNodeLabel(parts, "day"), SYSTEM_CLASS_UUIDS.day, ids.month);
  let appendedBlock: { id: string } | undefined;
  if (options.append !== undefined && options.append.trim() !== "") {
    const created = await ctx.client.postJson<{ id: string }>("/api/objects", {
      parentId: ids.day,
      contentAst: [{ type: "text", text: options.append }],
    });
    appendedBlock = { id: created.id };
  }
  const day = await getFullObject(ctx, ids.day);
  if (appendedBlock === undefined) {
    emit(ctx, `${JSON.stringify(day, null, 2)}\n`, day);
    return;
  }
  emit(
    ctx,
    `appended block ${appendedBlock.id} to ${day.name ?? ids.day}\n`,
    { ...day, appendedBlock },
  );
}

/** `notees journal`: daily notes, newest first. */
async function journal(ctx: CommandContext, options: { limit: string }): Promise<void> {
  const limit = Number.parseInt(options.limit, 10);
  const body = await ctx.client.getJson<{ objects: FullApiObject[] }>(
    `/api/objects?class=${SYSTEM_CLASS_UUIDS.day}&limit=500`,
  );
  const days = body.objects
    .map((object) => ({ object, parsed: parseDateNodeId(object.id) }))
    .filter((entry): entry is { object: FullApiObject; parsed: NonNullable<typeof entry.parsed> } => entry.parsed !== null)
    .sort((a, b) => (a.parsed.year - b.parsed.year) || (a.parsed.month - b.parsed.month) || (a.parsed.day - b.parsed.day))
    .reverse()
    .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20);
  const machine = { days: days.map(({ object }) => ({ id: object.id, name: object.name })) };
  emit(
    ctx,
    machine.days.map((day) => `${day.id}  ${day.name ?? ""}`).join("\n") + (machine.days.length > 0 ? "\n" : ""),
    machine,
  );
}

async function findOrCreatePerson(
  ctx: CommandContext,
  literal: string,
  counts: { personsCreated: number },
): Promise<string> {
  const existing = await findPersonByName(ctx, literal);
  if (existing !== undefined) return existing;
  const created = await ctx.client.postJson<{ id: string }>("/api/objects", {
    isEmbedded: false,
    name: literal,
    classIds: [SYSTEM_CLASS_UUIDS.person],
  });
  counts.personsCreated += 1;
  return created.id;
}

/** Citekey lookup — the property filter matches the JSON-encoded scalar. */
async function findSourceByCitekey(
  ctx: CommandContext,
  citekey: string,
): Promise<FullApiObject | undefined> {
  const query = queryString({ property: `${SYSTEM_PROPERTY_UUIDS.citekey}:${citekey}` });
  const body = await ctx.client.getJson<{ objects: { id: string }[] }>(`/api/objects${query}`);
  const first = body.objects[0];
  if (first === undefined) return undefined;
  return getFullObject(ctx, first.id);
}

async function exportBibtex(ctx: CommandContext, options: {
  ids?: string[];
  linkedTo?: string;
  depth?: string;
  fixpoint?: boolean;
  output?: string;
}): Promise<void> {
  const ids = requireExportSelectors("export bibtex", options);
  const depth = parseDepth(options);
  const resolver = makeObjectResolver(ctx.client);
  const included = await collectClosure(ctx.client, resolver, { ids, linkedTo: options.linkedTo, depth });

  // Only source-class nodes render as entries; the rest of the closure is
  // context (skipped, counted for the report).
  const rendered: string[] = [];
  const entryIds: string[] = [];
  let skipped = 0;

  // The authorship read contract is dual-track (SCHEMA.md "Citations", owner
  // 2026-10-23): `authors` text rows ("Family, Given") are the citation
  // source of truth; `linkedAuthors` ({nodeId} refs to agent nodes) is the
  // people-graph track that nodeToCsl resolves through resolveAgentName only
  // when no authors row resolves. Both ref kinds resolve to current display
  // names up front, batched through the objects API (the resolver caches per
  // id). Date-node refs (publicationDate) resolve through resolveName.
  const agentRefIds = new Set<string>();
  const dateRefIds = new Set<string>();
  for (const node of included.values()) {
    if (sourceClassOf(node.classIds) === undefined) continue;
    for (const property of node.properties) {
      if (property.schemaId !== SYSTEM_PROPERTY_UUIDS.linkedAuthors) continue;
      if (isRecord(property.value) && typeof property.value.nodeId === "string") {
        agentRefIds.add(property.value.nodeId);
      }
    }
    const pub = node.properties.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.publicationDate);
    if (pub !== undefined && isRecord(pub.value) && typeof pub.value.nodeId === "string") {
      dateRefIds.add(pub.value.nodeId);
    }
  }
  const agentNames = new Map<string, string>();
  for (const agentId of agentRefIds) {
    const agentNode = await resolver.getObject(agentId);
    if (agentNode === undefined) continue;
    const displayName = deriveDisplayName(agentNode) || agentNode.name?.trim() || "";
    if (displayName.length > 0) agentNames.set(agentId, displayName);
  }
  const dateNames = new Map<string, string>();
  for (const refId of dateRefIds) {
    const refNode = await resolver.getObject(refId);
    if (refNode === undefined) continue;
    const displayName = deriveDisplayName(refNode) || refNode.name?.trim() || "";
    if (displayName.length > 0) dateNames.set(refId, displayName);
  }

  for (const node of included.values()) {
    if (sourceClassOf(node.classIds) === undefined) {
      skipped += 1;
      continue;
    }
    rendered.push(
      serializeBibEntry(
        cslToBib(
          nodeToCsl(node, node.properties, {
            resolveName: (refId) => dateNames.get(refId),
            resolveAgentName: (refId) => agentNames.get(refId),
          }),
        ),
      ),
    );
    entryIds.push(node.id);
  }

  const text = rendered.join("\n\n") + (rendered.length > 0 ? "\n" : "");
  const machine = { entries: entryIds.length, skipped, ids: entryIds };
  if (options.output !== undefined) {
    writeFileSync(options.output, text);
    emit(ctx, `wrote ${entryIds.length} entries to ${options.output}\n`, machine);
    return;
  }
  emit(ctx, text, { ...machine, bib: text });
}

// --- program assembly --------------------------------------------------------

function rootOf(command: Command): Command {
  let root = command;
  while (root.parent !== null) root = root.parent;
  return root;
}

/** Resolve the shared per-invocation context from the root program options. */
function ctxOf(command: Command, options: { allowMissingKey?: boolean } = {}): CommandContext {
  const root = rootOf(command);
  const opts = root.opts<GlobalOptions>();
  const statePath = defaultStatePath();
  const { server, workspace } = requireServer(opts, statePath);
  const stateKey = `${opts.profile ?? "default"}:${server}`;
  const { apiKey } = resolveKey(opts, statePath, stateKey, options.allowMissingKey === true);
  return {
    io: (root.getOptionValue("__io") as CliIo | undefined) ?? defaultIo,
    opts,
    client: new ApiClient({
      server,
      apiKey,
      // exactOptionalPropertyTypes: omit rather than assign undefined.
      ...(workspace !== undefined ? { workspace } : {}),
      statePath,
      stateKey,
    }),
    statePath,
    stateKey,
  };
}

// --- auth --------------------------------------------------------------------

/**
 * `notees auth login` — email + password → session, then mint a dedicated CLI
 * API key (revocable from the app, nk_-shaped for older clients) and store it
 * per profile+server in the CLI state file (already mode 0600). Later
 * invocations fall back to the stored credential, so scripts stop minting
 * throwaway keys.
 */
async function authLogin(
  ctx: CommandContext,
  options: { email?: string; password?: string; passwordStdin?: boolean },
): Promise<void> {
  const email = options.email ?? process.env.NOTEES_EMAIL;
  if (email === undefined || email.length === 0) {
    failUsage("auth login requires --email <email> (or NOTEES_EMAIL)");
  }
  let password = options.password ?? process.env.NOTEES_PASSWORD;
  if (options.passwordStdin === true) password = (await readStdin(ctx.io)).trim();
  if (password === undefined || password.length === 0) {
    failUsage("auth login requires a password: --password <pw>, NOTEES_PASSWORD, or --password-stdin");
  }
  const login = await ctx.client.postJson<{ token: string; user: { email: string } }>("/api/auth/login", {
    email,
    password,
  });
  const keyClient = new ApiClient({ server: ctx.client.server, apiKey: login.token });
  const created = await keyClient.postJson<{ apiKey: { id: string }; token: string }>("/api/api-keys", {
    name: `notees-cli @ ${hostname()} (${new Date().toISOString().slice(0, 10)})`,
  });
  const credential: StoredCredential = {
    kind: "apiKey",
    token: created.token,
    keyId: created.apiKey.id,
    email: login.user.email,
    createdAt: new Date().toISOString(),
  };
  updateServerState(ctx.statePath, ctx.stateKey, (current) => ({ ...current, credential }));
  const profile = ctx.opts.profile ?? "default";
  emit(
    ctx,
    `logged in as ${email} — CLI API key stored for ${ctx.client.server} (profile ${profile})\n`,
    { email, server: ctx.client.server, profile, keyId: created.apiKey.id },
  );
}

/**
 * `notees auth store` — take an existing user API key (the global --key flag,
 * or --key-stdin), probe-verify it against the server (a 401 maps to exit 3,
 * network to 5), then write it per profile+server into the CLI state file
 * (mode 0600) — the same slot `auth login` writes. Unlike a login-minted key
 * there is no keyId, so `auth logout` clears it locally but cannot revoke it
 * server-side. The key is never printed; the machine output carries metadata
 * only.
 *
 * NB: the token comes from the root --key option on purpose — commander
 * matches options against the whole ancestor chain, so a `--key` after
 * `auth store` populates the global flag, and defining a second `--key` on
 * the subcommand would silently shadow it.
 */
async function authStore(ctx: CommandContext, options: { keyStdin?: boolean }): Promise<void> {
  const flagKey = ctx.opts.key;
  if (flagKey !== undefined && flagKey.length > 0 && options.keyStdin === true) {
    failUsage("auth store takes either --key or --key-stdin, not both");
  }
  let token: string | undefined;
  if (options.keyStdin === true) token = (await readStdin(ctx.io)).trim();
  else if (flagKey !== undefined && flagKey.length > 0) token = flagKey;
  if (token === undefined || token.length === 0) {
    failUsage("auth store requires a key: --key <credential> or --key-stdin");
  }
  await new ApiClient({ server: ctx.client.server, apiKey: token }).getJson("/api/classes");
  const credential: StoredCredential = {
    kind: "apiKey",
    token,
    createdAt: new Date().toISOString(),
  };
  updateServerState(ctx.statePath, ctx.stateKey, (current) => ({ ...current, credential }));
  const profile = ctx.opts.profile ?? "default";
  emit(
    ctx,
    `stored API key for ${ctx.client.server} (profile ${profile}) — verified against the server; ` +
      "`notees auth logout` clears it locally (server-side revocation only for CLI-minted keys)\n",
    { stored: true, server: ctx.client.server, profile, kind: credential.kind, createdAt: credential.createdAt },
  );
}

/** `notees auth logout` — revoke the stored key server-side, then clear it. */
async function authLogout(ctx: CommandContext): Promise<void> {
  const stored = serverState(ctx.statePath, ctx.stateKey).credential;
  if (stored === undefined) {
    failUsage(`no stored credential for ${ctx.client.server} (profile ${ctx.opts.profile ?? "default"})`);
  }
  if (stored.kind === "apiKey" && stored.keyId !== undefined && stored.token.length > 0) {
    // The key may authenticate its own revocation.
    const keyClient = new ApiClient({ server: ctx.client.server, apiKey: stored.token });
    await keyClient.deleteJson(`/api/api-keys/${encodeURIComponent(stored.keyId)}`);
  }
  updateServerState(ctx.statePath, ctx.stateKey, (current) => {
    const next = { ...current };
    delete next.credential;
    return next;
  });
  emit(ctx, `logged out — stored credential removed (server key revoked)\n`, { revoked: stored.kind === "apiKey" });
}

/** `notees auth status` — is a stored credential present, and does it still work? */
async function authStatus(ctx: CommandContext): Promise<void> {
  const stored = serverState(ctx.statePath, ctx.stateKey).credential;
  if (stored === undefined) {
    emit(ctx, `not logged in — no stored credential for ${ctx.client.server}\n`, { loggedIn: false });
    return;
  }
  const machine: Record<string, unknown> = {
    loggedIn: true,
    server: ctx.client.server,
    profile: ctx.opts.profile ?? "default",
    kind: stored.kind,
    email: stored.email ?? null,
    createdAt: stored.createdAt,
    valid: false,
  };
  let detail = "invalid or expired";
  try {
    await new ApiClient({ server: ctx.client.server, apiKey: stored.token }).getJson("/api/classes");
    machine.valid = true;
    detail = "valid";
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  machine.detail = detail;
  emit(
    ctx,
    `logged in as ${stored.email ?? "(unknown)"} — ${stored.kind} stored ${stored.createdAt.slice(0, 10)}, ${detail}\n`,
    machine,
  );
}

// --- config --------------------------------------------------------------------

interface ConfigContext {
  io: CliIo;
  opts: GlobalOptions;
  statePath: string;
  profile: string;
}

function emitConfig(ctx: ConfigContext, human: string, machine: unknown): void {
  if (ctx.opts.json === true) {
    ctx.io.stdout.write(`${JSON.stringify(machine, null, 2)}\n`);
  } else {
    ctx.io.stdout.write(human);
  }
}

/**
 * `notees config` never needs a server — it only touches the local state
 * file, so it resolves just io/profile/statePath (no requireServer, no
 * client, no credential).
 */
function configCtxOf(command: Command): ConfigContext {
  const root = rootOf(command);
  const opts = root.opts<GlobalOptions>();
  return {
    io: (root.getOptionValue("__io") as CliIo | undefined) ?? defaultIo,
    opts,
    statePath: defaultStatePath(),
    profile: opts.profile ?? "default",
  };
}

const CONFIG_KEYS = ["server", "workspace"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function configKeyOf(key: string): ConfigKey {
  if ((CONFIG_KEYS as readonly string[]).includes(key)) return key as ConfigKey;
  failUsage(`unknown config key ${key} (expected: ${CONFIG_KEYS.join(" or ")})`);
}

/** `notees config set server|workspace <value>` — persist the per-profile default. */
async function configSet(ctx: ConfigContext, key: ConfigKey, value: string): Promise<void> {
  if (value.length === 0) failUsage(`config set ${key} requires a non-empty value`);
  updateProfileDefaults(ctx.statePath, ctx.profile, (current) => ({
    ...current,
    [key]: value,
    updatedAt: new Date().toISOString(),
  }));
  emitConfig(ctx, `${key} default set to ${value} (profile ${ctx.profile})\n`, {
    key,
    value,
    profile: ctx.profile,
  });
}

/** `notees config get server|workspace` — print the stored default (null when unset). */
async function configGet(ctx: ConfigContext, key: ConfigKey): Promise<void> {
  const value = profileDefaults(ctx.statePath, ctx.profile)[key];
  if (value === undefined) {
    emitConfig(ctx, `no default ${key} set (profile ${ctx.profile})\n`, {
      key,
      value: null,
      profile: ctx.profile,
    });
    return;
  }
  emitConfig(ctx, `${key}: ${value} (profile ${ctx.profile})\n`, { key, value, profile: ctx.profile });
}

/** `notees config list` — both stored defaults for this profile. */
async function configList(ctx: ConfigContext): Promise<void> {
  const defaults = profileDefaults(ctx.statePath, ctx.profile);
  const server = defaults.server ?? null;
  const workspace = defaults.workspace ?? null;
  emitConfig(
    ctx,
    `profile ${ctx.profile}\nserver: ${server ?? "(not set)"}\nworkspace: ${workspace ?? "(not set)"}\n`,
    { profile: ctx.profile, server, workspace },
  );
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("notees")
    .description("Notees CLI")
    .version(CLI_VERSION)
    .option("--json", "stable machine-readable output")
    .option("--server <url>", "server base URL (env NOTEES_SERVER, else `notees config set server`; required if neither)")
    .option("--key <credential>", "operator key, user API key, or session token (env NOTEES_API_KEY)")
    .option("--workspace <name|id>", "workspace for the object API (env NOTEES_WORKSPACE, else `notees config set workspace`; default: the server's default workspace)", undefined)
    .option("--profile <name>", "profile name for local state", "default")
    .exitOverride();

  const object = program.command("object").description("object operations");
  object
    .command("get [id]")
    .description("fetch an object (--ids <uuid...> fetches many, in order)")
    .addOption(new Option("--ids <uuid...>", "fetch several objects (mutually exclusive with the positional id)"))
    .action(async (id: string | undefined, options: { ids?: string[] }, command: Command) => {
      if (options.ids !== undefined && options.ids.length > 0) {
        if (id !== undefined) failUsage("object get takes either an id or --ids, not both");
        await objectGetMany(ctxOf(command), options.ids);
        return;
      }
      if (id === undefined) failUsage("object get requires an id or --ids");
      await objectGet(ctxOf(command), id);
    });
  object
    .command("create")
    .description("create an object (prints the new id)")
    .option("--isClass", "declare a class node (a root: no --parent/--class/--isEmbedded)")
    .addOption(
      new Option("--isEmbedded", "create embedded in the parent's body (the Block role — the server default when parented)").default(
        undefined,
      ),
    )
    .addOption(
      new Option("--no-isEmbedded", "create standalone (the Page role — the parent's main-children zone)"),
    )
    .option("--name <name>", "object name")
    .option(
      "--content <json>",
      "contentAst token array for rich content (mentions, markdown links [label](href) in text tokens, …; mutually exclusive with --name)",
    )
    .option("--class <id>", "class id (repeatable)", (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option("--parent <id>", "parent object id")
    .option("--icon <icon>", "icon (applied via a follow-up update — see object.update)")
    .option("--color <color>", "color (applied via a follow-up update)")
    .option("--stdin", "read the object body as JSON from stdin")
    .option("--batch", "read a JSON array of create bodies from stdin and create them all (see --jobs)", false)
    .option("--jobs <n>", "batch concurrency 1–32 (default 8; entries under one parent always stay in order)", "8")
    .option("--stop-on-error", "batch: abort the remaining entries on the first failure", false)
    .action(async (options: { batch?: boolean; stdin?: boolean; jobs?: string; stopOnError?: boolean } & object, command: Command) => {
      if (options.batch === true) {
        if (options.stdin === true) failUsage("--batch and --stdin are mutually exclusive");
        await objectCreateBatch(ctxOf(command), options);
        return;
      }
      await objectCreate(ctxOf(command), options);
    });
  object
    .command("restore <ids...>")
    .description("restore trashed objects (whole-tree; descendants trashed independently stay trashed)")
    .action(async (ids: string[], _options: object, command: Command) => {
      await objectRestore(ctxOf(command), ids);
    });
  object
    .command("move <id>")
    .description("move a node under a new parent (optionally anchored next to a sibling)")
    .option("--parent <id>", "new parent object id (required)", undefined)
    .option("--after <id>", "place right after this sibling", undefined)
    .option("--before <id>", "place right before this sibling", undefined)
    .action(async (id: string, options: { parent?: string; after?: string; before?: string }, command: Command) => {
      await objectMove(ctxOf(command), id, options);
    });
  object
    .command("merge <source> <target>")
    .description(
      "merge one object into another: the source's children move, its class/tag bindings and authored properties remap " +
        "(the target keeps values it already has), references to the source (mentions, property references, aliases, " +
        "collections) retarget, and the source moves to the trash. Preview-first: --dry-run shows the plan, --yes proceeds",
    )
    .option("--dry-run", "print the merge plan without writing", false)
    .option("--yes", "proceed without prompting (required — destructive)", false)
    .action(async (source: string, target: string, options: { dryRun?: boolean; yes?: boolean }, command: Command) => {
      await objectMerge(ctxOf(command), source, target, options);
    });
  const property = object.command("property").description("typed property operations");
  property
    .command("set <id> <schema> <value>")
    .description(
      "set a property value (schema: uuid or name; value parses as JSON when possible, else string; " +
        "text values may be a string or a {\"nodeId\":\"…\"} carrier-block ref)",
    )
    .option("--idx <n>", "slot index for multi-valued schemas", "0")
    .action(async (id: string, schema: string, value: string, options: { idx?: string }, command: Command) => {
      await objectPropertySet(ctxOf(command), id, schema, value, options);
    });
  property
    .command("delete <id> <schema>")
    .description("unset a property value (schema: uuid or name)")
    .option("--idx <n>", "slot index for multi-valued schemas", "0")
    .action(async (id: string, schema: string, options: { idx?: string }, command: Command) => {
      await objectPropertyDelete(ctxOf(command), id, schema, options);
    });

  const cover = program.command("cover").description("node covers — the one-gesture image cover (asset node + the coverAssetId wire field)");
  cover
    .command("set <nodeId> [file]")
    .description("set a node's cover from a file (or --asset <assetNodeId>); replaces by default, --skip-existing for re-runnable scripts")
    .option("--asset <assetNodeId>", "point the cover at an existing asset node instead of uploading")
    .option("--skip-existing", "when a cover is already set, print its asset id and change nothing", false)
    .action(async (nodeId: string, file: string | undefined, options: { asset?: string; skipExisting?: boolean }, command: Command) => {
      await coverSet(ctxOf(command), nodeId, file, options);
    });
  cover
    .command("get <nodeId>")
    .description("print the cover's asset node id")
    .action(async (nodeId: string, _options: object, command: Command) => {
      await coverGet(ctxOf(command), nodeId);
    });
  cover
    .command("clear <nodeId>")
    .description("remove the cover (the asset node survives — it stays an ordinary asset)")
    .action(async (nodeId: string, _options: object, command: Command) => {
      await coverClear(ctxOf(command), nodeId);
    });

  const schemaCmd = program.command("property").description("property schema operations");
  schemaCmd
    .command("list")
    .description("list property schemas")
    .action(async (_options: object, command: Command) => {
      await propertyList(ctxOf(command));
    });
  schemaCmd
    .command("get <schema>")
    .description("show one property schema with its resolved eligible classes (schema: uuid or name)")
    .action(async (schema: string, _options: object, command: Command) => {
      await propertyGet(ctxOf(command), schema);
    });
  schemaCmd
    .command("create <name>")
    .description("create a property schema (prints the new id)")
    .option("--type <type>", "property type (default: text)", "text")
    .option("--multi", "allow multiple values", false)
    .option("--option <label>", "select option label (repeatable)", (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option("--targetClass <ref>", "constrain node-typed targets to this class (repeatable; uuid or title)", (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option("--pad <n>", "number schemas: zero-pad the integer part to N digits (display only)")
    .option("--decimals <n>", "number schemas: digits after the point 0-10 (display only)")
    .option("--rounding <mode>", "number schemas: round | floor | ceil | truncate (display only)")
    .option("--default <json>", "the property's one global default value (JSON, typed per --type; a wrong-typed default is rejected server-side)")
    .action(async (name: string, options: { type?: string; multi?: boolean; option?: string[]; targetClass?: string[]; pad?: string; decimals?: string; rounding?: string; default?: string }, command: Command) => {
      await propertyCreate(ctxOf(command), name, options);
    });
  schemaCmd
    .command("rename <schema> <name>")
    .description("rename a property schema (schema: uuid or name)")
    .action(async (schema: string, name: string, _options: object, command: Command) => {
      await propertyRename(ctxOf(command), schema, name);
    });
  schemaCmd
    .command("delete <schema>")
    .description("delete a property schema — soft-delete: bindings go inactive, authored values survive (schema: uuid or name; requires --yes)")
    .option("--yes", "confirm the destructive action", false)
    .action(async (schema: string, options: { yes?: boolean }, command: Command) => {
      await propertyDelete(ctxOf(command), schema, options);
    });
  schemaCmd
    .command("bind <class> <schema>")
    .description(
      "bind a property schema to a class (class.property.set; class/schema: uuid or title/name — the binding is presence-only: " +
        "class properties render alphabetically, the global default lives on the schema via property create --default)",
    )
    .action(async (classRef: string, schemaRef: string, _options: object, command: Command) => {
      await propertyBind(ctxOf(command), classRef, schemaRef);
    });
  schemaCmd
    .command("unbind <class> <schema>")
    .description("remove a class binding (class.property.unset; authored values survive)")
    .action(async (classRef: string, schemaRef: string, _options: object, command: Command) => {
      await propertyUnbind(ctxOf(command), classRef, schemaRef);
    });
  object
    .command("children <id>")
    .description(
      "list an object's children in child-position order (main children and inline blocks; " +
        "the endpoint is unpaginated — --offset/--limit window client-side, --count prints just the number, --fields projects rows)",
    )
    .option("--offset <n>", "skip the first n children", undefined)
    .option("--limit <n>", "return at most n children", undefined)
    .option("--count", "print only the child count", false)
    .option("--fields <a,b,c>", "project each row to these keys (id is always kept)", undefined)
    .action(async (id: string, options: { offset?: string; limit?: string; count?: boolean; fields?: string }, command: Command) => {
      await objectChildren(ctxOf(command), id, options);
    });
  object
    .command("upsert")
    .description("find-or-create by exact title within --class/--parent scopes (prints the id; creates nothing when exactly one match exists)")
    .option("--name <name>", "object title to find or create", "")
    .option("--class <id>", "class id scope (repeatable)", (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option("--parent <id>", "parent object id scope")
    .addOption(
      new Option("--isEmbedded", "create embedded in the parent's body (the Block role — the server default when parented)").default(undefined),
    )
    .addOption(new Option("--no-isEmbedded", "create standalone (the Page role — the parent's main-children zone)"))
    .action(async (options: { name?: string; class?: string[]; parent?: string; isEmbedded?: boolean }, command: Command) => {
      await objectUpsert(ctxOf(command), options);
    });
  object
    .command("update <id>")
    .description("update an object")
    .option("--name <name>", "new name")
    .option(
      "--content <json>",
      "replace the node's content with this contentAst token array (mentions, markdown links [label](href) in text tokens, …; mutually exclusive with --name)",
    )
    .addOption(
      new Option("--isEmbedded", "demote: embed the node in the parent's body (the Block role)").default(
        undefined,
      ),
    )
    .addOption(new Option("--no-isEmbedded", "promote: standalone under the parent (the Page role)"))
    .option("--icon <icon>", "icon")
    .option("--color <color>", "color: preset token (red…gray) or #RRGGBB; 'none' clears")
    .action(async (id: string, options: { name?: string; isEmbedded?: boolean; icon?: string; color?: string }, command: Command) => {
      await objectUpdate(ctxOf(command), id, options);
    });
  object
    .command("delete <id>")
    .description("delete an object (requires --yes)")
    .option("--permanent", "permanently delete (unrecoverable)", false)
    .option("--yes", "confirm the destructive action", false)
    .action(async (id: string, options: { permanent?: boolean; yes?: boolean }, command: Command) => {
      await objectDelete(ctxOf(command), id, options);
    });
  object
    .command("list")
    .description("list objects")
    .addOption(new Option("--isClass", "filter: class nodes only").default(undefined))
    .addOption(new Option("--no-isClass", "filter: non-class nodes only"))
    .addOption(
      new Option(
        "--isEmbedded",
        "filter: embedded body rows (parented non-class nodes with the flag set — blocks)",
      ).default(undefined),
    )
    .addOption(
      new Option("--no-isEmbedded", "filter: standalone rows (non-class roots + child pages — the pages listing)"),
    )
    .option("--class <id>", "class id (repeatable)", (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option("--parent <id>", "filter: direct children of this object id")
    .addOption(new Option("--trashed", "filter: trashed (inactive) rows — the trash listing").default(undefined))
    .option("--q <text>", "full-text filter")
    .option("--property <schemaId:value>", "exact-match property filter (value = everything after the first colon)")
    .option("--limit <n>", "page size")
    .option("--cursor <id>", "pagination cursor")
    .option("--all", "fetch every page (follows the cursor to exhaustion; --limit becomes the page size)", false)
    .action(async (options: object, command: Command) => {
      await objectList(ctxOf(command), options);
    });

  program
    .command("search <query>")
    .description(
      "search — plain text (FTS) or the query language: class:Name (name or uuid), isClass:true|false, isEmbedded:true|false, " +
        "prop:name:<op>value (:= != :> :>= :< :<=, bare : = contains, no value = exists; schema by name or uuid), " +
        "bare schema fields (year:>2010), text:term, linked:Name (name or uuid), \"quoted phrases\", AND OR NOT, ( )",
    )
    .addOption(new Option("--isClass", "filter: class nodes only (plain-text search only)").default(undefined))
    .addOption(new Option("--no-isClass", "filter: non-class nodes only (plain-text search only)"))
    .addOption(
      new Option("--isEmbedded", "filter: embedded body rows only — blocks (plain-text search only)").default(undefined),
    )
    .addOption(
      new Option("--no-isEmbedded", "filter: standalone rows only — pages (plain-text search only)"),
    )
    .action(async (queryText: string, options: { isClass?: boolean; isEmbedded?: boolean }, command: Command) => {
      await search(ctxOf(command), queryText, options);
    });

  program
    .command("today")
    .description("open today's daily note — ensures the local date chain and the day page, prints it")
    .option("--append <text>", "append a text block to the daily note and report the created block id")
    .action(async (options: { append?: string }, command: Command) => {
      await today(ctxOf(command), options);
    });

  program
    .command("journal")
    .description("list daily notes, newest first")
    .option("--limit <n>", "max entries", "20")
    .action(async (options: { limit: string }, command: Command) => {
      await journal(ctxOf(command), options);
    });

  const klass = program.command("class").description("class operations");
  klass
    .command("list")
    .description("list classes (flat table; --tree renders the extends hierarchy)")
    .option("--tree", "render the extends hierarchy as an indented tree", false)
    .action(async (options: { tree?: boolean }, command: Command) => {
      await classList(ctxOf(command), options);
    });
  klass
    .command("assign <objectId> <class>")
    .description("assign an object to a class (class: uuid or title; idempotent)")
    .action(async (objectId: string, classRef: string, _options: object, command: Command) => {
      await classMembership(ctxOf(command), objectId, classRef, "assign");
    });
  klass
    .command("unassign <objectId> <class>")
    .description("remove an object's class membership (class: uuid or title; idempotent)")
    .action(async (objectId: string, classRef: string, _options: object, command: Command) => {
      await classMembership(ctxOf(command), objectId, classRef, "unassign");
    });
  klass
    .command("remap <from> <to>")
    .description(
      "move every member of a class to another class and remap extends edges (from/to: uuid or title; " +
        "the emptied class stays; --parent scopes to members under one parent; requires --yes, preview without it, --dry-run to inspect)",
    )
    .option("--dry-run", "print what would move and exit 0 without writing", false)
    .option("--yes", "confirm the bulk remap", false)
    .option("--parent <id>", "scope: only members whose direct parent is this object id", undefined)
    .option("--jobs <n>", "member-move concurrency 1–32 (default 8; membership is order-free)", "8")
    .action(async (fromRef: string, toRef: string, options: { dryRun?: boolean; yes?: boolean; parent?: string; jobs?: string }, command: Command) => {
      await classRemap(ctxOf(command), fromRef, toRef, options);
    });
  klass
    .command("empty <class>")
    .description("unassign every member of a class (the nodes stay; class: uuid or title; --parent scopes to one parent's members; idempotent)")
    .option("--parent <id>", "scope: only members whose direct parent is this object id", undefined)
    .action(async (classRef: string, options: { parent?: string }, command: Command) => {
      await classBulkMembers(ctxOf(command), classRef, "unassign", options);
    });
  klass
    .command("delete-members <class>")
    .description(
      "trash every member node of a class (recoverable from the trash; class: uuid or title; --parent scopes to one parent's members; " +
        "requires --yes, preview without it, --dry-run to inspect)",
    )
    .option("--dry-run", "print what would be trashed and exit 0 without writing", false)
    .option("--yes", "confirm the bulk trash", false)
    .option("--parent <id>", "scope: only members whose direct parent is this object id", undefined)
    .action(async (classRef: string, options: { dryRun?: boolean; yes?: boolean; parent?: string }, command: Command) => {
      await classBulkMembers(ctxOf(command), classRef, "trash", options);
    });

  const auth = program.command("auth").description("sign in and store a credential for this server");
  auth
    .command("login")
    .description("log in with email + password and store a CLI API key (per profile)")
    .option("--email <email>", "account email (env NOTEES_EMAIL)")
    .option("--password <pw>", "account password (env NOTEES_PASSWORD) — prefer --password-stdin to keep it out of shell history")
    .option("--password-stdin", "read the password from stdin", false)
    .action(async (options: { email?: string; password?: string; passwordStdin?: boolean }, command: Command) => {
      await authLogin(ctxOf(command, { allowMissingKey: true }), options);
    });
  auth
    .command("store")
    .description(
      "verify and store an existing API key as the standing credential (pass it with the global --key flag, or use " +
        "--key-stdin); `auth logout` clears it locally (server-side revocation only for CLI-minted keys)",
    )
    .option("--key-stdin", "read the key from stdin (mutually exclusive with the global --key flag)", false)
    .action(async (options: { keyStdin?: boolean }, command: Command) => {
      await authStore(ctxOf(command, { allowMissingKey: true }), options);
    });
  auth
    .command("logout")
    .description("revoke the stored CLI API key and remove it from the state file")
    .action(async (_options: object, command: Command) => {
      await authLogout(ctxOf(command, { allowMissingKey: true }));
    });
  auth
    .command("status")
    .description("is a stored credential present for this server, and does it still authenticate?")
    .action(async (_options: object, command: Command) => {
      await authStatus(ctxOf(command, { allowMissingKey: true }));
    });

  const config = program
    .command("config")
    .description("per-profile defaults (default server, default workspace) so bare `notees <cmd>` works without env vars");
  config
    .command("set <key> <value>")
    .description("store a default for this profile: key is `server` (base URL) or `workspace` (name|id)")
    .action(async (key: string, value: string, _options: object, command: Command) => {
      await configSet(configCtxOf(command), configKeyOf(key), value);
    });
  config
    .command("get <key>")
    .description("print the stored default for `server` or `workspace` (nothing stored → empty value, exit 0)")
    .action(async (key: string, _options: object, command: Command) => {
      await configGet(configCtxOf(command), configKeyOf(key));
    });
  config
    .command("list")
    .description("print both stored defaults for this profile")
    .action(async (_options: object, command: Command) => {
      await configList(configCtxOf(command));
    });

  program
    .command("ops [opType]")
    .description("list the operation catalog (or one op's description, example payload, and affected-node shape)")
    .action(async (opType: string | undefined, _options: object, command: Command) => {
      await opsList(ctxOf(command), opType);
    });

  program
    .command("backlinks <id>")
    .description("list backlinks to an object")
    .action(async (id: string, _options: object, command: Command) => {
      await backlinks(ctxOf(command), id);
    });

  const asset = program.command("asset").description("asset operations");
  asset
    .command("add <file>")
    .description("upload a file (prints the asset id)")
    .option("--object <id>", "attach to this object")
    .action(async (filePath: string, options: { object?: string }, command: Command) => {
      await assetAdd(ctxOf(command), filePath, options);
    });
  asset
    .command("get <id>")
    .description("download an asset")
    .option("--output <path>", "write to a file instead of stdout")
    .action(async (id: string, options: { output?: string }, command: Command) => {
      await assetGet(ctxOf(command), id, options);
    });

  const sync = program.command("sync").description("sync operations");
  sync
    .command("status")
    .description("server stats + local cursor")
    .action(async (_options: object, command: Command) => {
      await syncStatus(ctxOf(command));
    });

  program
    .command("doctor")
    .description("auth + reachability + version probe")
    .action(async (_options: object, command: Command) => {
      await doctor(ctxOf(command));
    });

  program
    .command("shell [script]")
    .description("interactive object-API shell (Node REPL with helpers; a script file argument or piped stdin runs as a one-shot script)")
    .action(async (script: string | undefined, _options: object, command: Command) => {
      const ctx = ctxOf(command);
      await runShell({
        client: ctx.client,
        io: ctx.io,
        json: ctx.opts.json === true,
        stdin: ctx.io.stdin,
        ...(script !== undefined ? { scriptFile: script } : {}),
      });
    });

  const exportCmd = program.command("export").description("export operations");
  exportCmd
    .command("markdown")
    .description("export objects as Markdown (<uuid>.md files + notees-manifest.json)")
    .addOption(new Option("--ids <uuid...>", "export exactly these object ids (no closure)"))
    .option("--linked-to <uuid>", "export the seed plus the pages that transitively link to it")
    .option("--class <id|title>", "export the class's current members (seeds the bundle like --ids)")
    .addOption(
      new Option("--depth <n>", "closure hops beyond the seed's direct referrers (hops = depth + 1; default 3)").default("3"),
    )
    .option("--fixpoint", "expand the closure until no new pages are found", false)
    .option("--output-dir <dir>", "write the bundle into this directory")
    .option("--stdout", "print the concatenated bundle instead of writing files", false)
    .action(
      async (
        options: {
          ids?: string[];
          linkedTo?: string;
          class?: string;
          depth?: string;
          fixpoint?: boolean;
          outputDir?: string;
          stdout?: boolean;
        },
        command: Command,
      ) => {
        await exportMarkdown(ctxOf(command), {
          ...options,
          ...(options.class !== undefined ? { classRef: options.class } : {}),
        });
      },
    );
  exportCmd
    .command("json")
    .description(
      "export objects as a JSON archive (notees-json-archive v1: nodes with contentAst, classIds, properties, child ids, edges)",
    )
    .addOption(new Option("--ids <uuid...>", "export exactly these object ids (no closure)"))
    .option("--linked-to <uuid>", "export the seed plus the pages that transitively link to it")
    .option("--class <id|title>", "export the class's current members (seeds the archive like --ids)")
    .addOption(
      new Option("--depth <n>", "closure hops beyond the seed's direct referrers (hops = depth + 1; default 3)").default("3"),
    )
    .option("--fixpoint", "expand the closure until no new pages are found", false)
    .option("--output <file>", "write the archive to this file instead of stdout")
    .action(
      async (
        options: {
          ids?: string[];
          linkedTo?: string;
          class?: string;
          depth?: string;
          fixpoint?: boolean;
          output?: string;
        },
        command: Command,
      ) => {
        await exportJson(ctxOf(command), {
          ...options,
          ...(options.class !== undefined ? { classRef: options.class } : {}),
        });
      },
    );
  exportCmd
    .command("bibtex")
    .description("export source objects as a BibTeX document (sources only; closure nodes without a source class are skipped)")
    .addOption(new Option("--ids <uuid...>", "export exactly these object ids (no closure)"))
    .option("--linked-to <uuid>", "export the seed plus the pages that transitively link to it")
    .addOption(
      new Option("--depth <n>", "closure hops beyond the seed's direct referrers (hops = depth + 1; default 3)").default("3"),
    )
    .option("--fixpoint", "expand the closure until no new pages are found", false)
    .option("--output <file>", "write the .bib document to this file instead of stdout")
    .action(
      async (
        options: {
          ids?: string[];
          linkedTo?: string;
          depth?: string;
          fixpoint?: boolean;
          output?: string;
        },
        command: Command,
      ) => {
        await exportBibtex(ctxOf(command), options);
      },
    );

  const importCmd = program.command("import").description("import operations (bibtex / csl-json / zotero-rdf sources)");
  const importOptions = (cmd: Command): Command =>
    cmd
      .option("--dry-run", "plan only: report per-entry actions and planned persons/schemas, write nothing", false)
      .addOption(new Option("--no-create", "match only: skip entries that would create a new source"));
  importOptions(importCmd.command("bibtex <file>"))
    .description(
      "import a .bib file (find-or-create author persons; upsert by citekey, adopt @citekey-titled nodes)",
    )
    .action(async (filePath: string, options: SourceImportOptions, command: Command) => {
      await importBibtex(ctxOf(command), filePath, options);
    });
  importOptions(importCmd.command("csl-json <file>"))
    .description("import a CSL-JSON file (top-level array or an object with an items array)")
    .action(async (filePath: string, options: SourceImportOptions, command: Command) => {
      await importCslJson(ctxOf(command), filePath, options);
    });
  importOptions(importCmd.command("zotero-rdf <file>"))
    .description("import a Zotero RDF export (bib:* entries; unkeyed top-level items are skipped)")
    .action(async (filePath: string, options: SourceImportOptions, command: Command) => {
      await importZoteroRdf(ctxOf(command), filePath, options);
    });

  return program;
}

/** Parse and run argv (user-style, without node/script prefix); resolves to the process exit code. */
export async function run(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const program = buildProgram();
  program.setOptionValue("__io", io);
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return EXIT.ok; // --help / --version
      const message = error.message.length > 0 ? error.message : "invalid usage";
      io.stderr.write(`notees: ${message}\n`);
      return EXIT.usage;
    }
    if (error instanceof CliError) {
      io.stderr.write(`notees: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr.write(`notees: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.domain;
  }
}

// Direct-execution guard: only run() when this file is the entry. argv[1] is
// the path as invoked — which may be a symlink (install.sh links
// `notees -> notees.mjs`, packages link /usr/bin/<name>) while import.meta.url
// carries the resolved realpath, so compare both spellings; a plain equality
// check silently no-ops when invoked through a symlink.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const asGiven = pathToFileURL(entry).href;
  let resolved = asGiven;
  try {
    resolved = pathToFileURL(realpathSync(entry)).href;
  } catch {
    // Unresolvable entry: keep the as-given spelling.
  }
  return import.meta.url === asGiven || import.meta.url === resolved;
})();
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`notees: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT.domain;
    });
}

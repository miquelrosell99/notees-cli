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
} from "@notees/export";
import { OP_CATALOG, describeOp, newEnvelope, Clock } from "@notees/protocol";
import {
  looksLikeQueryLanguage,
  parseQueryLanguage,
  type QueryAst,
} from "@notees/query";

import { ApiClient } from "./client.js";
import { CliError, EXIT } from "./exit-codes.js";
import {
  buildMarkdownBundle,
  collectClosure,
  isRecord,
  makeObjectResolver,
} from "./markdown-export.js";
import { buildJsonArchiveDocument } from "./json-export.js";
import { runShell } from "./shell.js";
import { defaultStatePath, serverState, updateServerState, type StoredCredential } from "./state.js";
import { formatTable, queryString, readStdin } from "./util.js";
import { DEFAULT_WORKSPACE_ID, deriveUuid, uuidv7 } from "./uuid.js";

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

function requireServer(opts: GlobalOptions): { server: string; workspace: string | undefined } {
  const server = opts.server ?? process.env.NOTEES_SERVER;
  const workspace = opts.workspace ?? process.env.NOTEES_WORKSPACE;
  if (server === undefined || server.length === 0) {
    failUsage("server URL required: pass --server <url> or set NOTEES_SERVER");
  }
  return { server, workspace };
}

/**
 * Credential resolution order: --key > NOTEES_API_KEY > the credential stored
 * by `notees auth login` for this profile+server. No client-side shape check:
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
  failUsage("credential required: pass --key, set NOTEES_API_KEY, or run `notees auth login` for this server");
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
  presentAsMain?: boolean;
  isClass?: boolean;
  name?: string;
  class?: string[];
  parent?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  // Revision 11 render state: --isClass declares a class node (a root —
  // rejected server-side alongside --parent/--class); --presentAsMain sets
  // the render bit (server default: true when parentless, false when
  // parented).
  if (options.isClass === true) body.isClass = true;
  if (options.presentAsMain !== undefined) body.presentAsMain = options.presentAsMain;
  if (options.name !== undefined) body.name = options.name;
  if (options.parent !== undefined) body.parentId = options.parent;
  const classIds = options.class ?? [];
  if (classIds.length > 0) body.classIds = classIds;
  return body;
}

/**
 * `--content <json>`: a contentAst token array (mentions, external links,
 * … — the server is the strict shape gate). The array-ness is validated
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
  presentAsMain?: boolean;
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
 * `contentAst`, `parentId`, `presentAsMain`, `classIds`, … — the server
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
    renderKindLabel(child as { isClass?: boolean; presentAsMain?: boolean; parentId?: string | null }),
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
  presentAsMain?: boolean;
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
    ...(options.presentAsMain !== undefined ? { presentAsMain: options.presentAsMain } : {}),
  });
  const created = await ctx.client.postJson<{ id: string; object: unknown }>("/api/objects", createBody);
  emit(ctx, `${created.id}\n`, { ...created, created: true });
}

async function objectUpdate(ctx: CommandContext, id: string, options: {
  name?: string;
  content?: string;
  presentAsMain?: boolean;
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
  // Promotion/demotion: flip the render bit between the parent's
  // main-children zone (true) and the inline body (false).
  if (options.presentAsMain !== undefined) body.presentAsMain = options.presentAsMain;
  if (options.icon !== undefined) body.icon = options.icon;
  if (options.color !== undefined) {
    // Color grammar (SCHEMA.md): preset token or #RRGGBB; "none" clears.
    body.color = options.color.toLowerCase() === "none" ? null : options.color;
  }
  if (Object.keys(body).length === 0) {
    failUsage("object update requires at least one of --name, --content, --presentAsMain, --icon, --color");
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
function renderKindLabel(node: { isClass?: boolean; presentAsMain?: boolean; parentId?: string | null }): string {
  if (node.isClass === true) return "class";
  if (node.isClass === false) {
    return node.parentId === null || node.presentAsMain === true ? "page" : "block";
  }
  return "object";
}

async function objectDelete(ctx: CommandContext, id: string, options: { permanent?: boolean; yes?: boolean }): Promise<void> {
  const permanent = options.permanent === true;
  if (options.yes !== true) {
    // Blast-radius preview — never prompt when --json or non-tty.
    let preview: { name?: string | null; isClass?: boolean; presentAsMain?: boolean } = {};
    try {
      const fetched = await ctx.client.getJson<{ object: { name?: string | null; isClass?: boolean; presentAsMain?: boolean } }>(
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
  presentAsMain?: boolean;
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
    presentAsMain: options.presentAsMain,
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
    renderKindLabel(object as { isClass?: boolean; presentAsMain?: boolean; parentId?: string | null }),
    String(object.id),
  ]);
  emit(ctx, `${formatTable([["NAME", "KIND", "ID"], ...rows])}\n`, machine);
}

async function search(ctx: CommandContext, queryText: string, options: { isClass?: boolean; presentAsMain?: boolean }): Promise<void> {
  // Plain text goes to the FTS endpoint; query-language syntax (class:,
  // prop:…, AND/OR/NOT, quotes — see looksLikeQueryLanguage) is compiled to a
  // QueryAST here and executed through POST /api/query. DSL parse errors
  // fail loud (exit 2) with the parser's message — never silently degraded
  // to a text search.
  if (!looksLikeQueryLanguage(queryText)) {
    const query = queryString({ q: queryText, isClass: options.isClass, presentAsMain: options.presentAsMain });
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
  presentAsMain: boolean;
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

async function classList(ctx: CommandContext): Promise<void> {
  const body = await ctx.client.getJson<{
    classes: Array<{ id: string; name: string; memberCount: number; parentClassIds: string[] }>;
  }>("/api/classes");
  const rows = body.classes.map((klass) => [
    klass.name.length > 0 ? klass.name : "(untitled)",
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
const CLI_VERSION = "3.2.3";

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
 * Fixed ids of the cover family: the cover property (type image)
 * binds to `source`; the cover target is an ordinary asset-classed node —
 * the `cover` system class was withdrawn the day it shipped (it duplicated
 * the property's meaning). The property VALUE stays the authority, exactly
 * like the web client's coverProperty.ts flows.
 */
const ASSET_CLASS_ID = "00000000-0000-0000-0001-000000000009";
const SOURCE_CLASS_ID = "00000000-0000-0000-0001-000000000023";
const COVER_PROPERTY_ID = "00000000-0000-0000-0000-000000000005";

interface FullObject {
  id: string;
  properties?: Array<{ schemaId: string; idx?: number; value: unknown }>;
  classIds?: string[];
  [key: string]: unknown;
}

async function getObject(ctx: CommandContext, id: string): Promise<FullObject> {
  const body = await ctx.client.getJson<{ object: FullObject }>(`/api/objects/${encodeURIComponent(id)}`);
  return body.object;
}

/** The cover property's asset target on a node (null = no cover). */
function coverAssetOf(object: FullObject): string | null {
  const cover = (object.properties ?? []).find(
    (property) => property.schemaId === COVER_PROPERTY_ID && (property.idx ?? 0) === 0,
  );
  const target = cover?.value as { nodeId?: unknown } | undefined;
  return typeof target?.nodeId === "string" ? target.nodeId : null;
}

/**
 * Author the cover family when missing (idempotent, mirroring the web
 * self-heal): the asset/source class roots at their fixed ids, the
 * image-typed cover schema, and the source-class binding. Class writes ride
 * the relay batch (configuration ops have no REST surface); the schema uses
 * the property schemas endpoint. Binding assumption: an existing cover
 * schema implies the binding (the web self-heal authors both together; the
 * migration too) — the binding envelope is written only alongside a
 * schema this call created. No cover class (withdrawn same-day).
 */
async function ensureCoverProperty(ctx: CommandContext): Promise<void> {
  const { classes } = await ctx.client.getJson<{ classes: Array<{ id: string }> }>(
    "/api/classes",
  );
  const byId = new Map(classes.map((klass) => [klass.id, klass]));
  const workspaceId = (await ctx.client.workspaceId()) ?? DEFAULT_WORKSPACE_ID;
  const clock = new Clock("notees-cli");
  const actorId = deriveUuid(`notees:actor:cli:${ctx.client.apiKey}`);
  const envelopes = [];
  const missingRoots = [
    ["asset", ASSET_CLASS_ID, "mdiPaperclip"],
    ["source", SOURCE_CLASS_ID, "mdiBookshelf"],
  ].filter(([, id]) => !byId.has(id as string));
  for (const [name, id, icon] of missingRoots) {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId,
        deviceId: "notees-cli",
        client: "cli",
        hlc: clock.now(),
        affectedNodeIds: [id as string],
        opType: "class.create",
        payload: { classId: id, contentAst: [{ type: "text", text: name }], icon },
      }),
    );
  }
  let createdSchema = false;
  try {
    await ctx.client.getJson(`/api/property-schemas/${COVER_PROPERTY_ID}`);
  } catch (error) {
    if (!(error instanceof CliError) || error.exitCode !== EXIT.domain) throw error;
    await ctx.client.postJson("/api/property-schemas", {
      propertySchemaId: COVER_PROPERTY_ID,
      name: "cover",
      type: "image",
      multi: false,
      scope: "class",
    });
    createdSchema = true;
  }
  if (createdSchema || missingRoots.length > 0) {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId,
        deviceId: "notees-cli",
        client: "cli",
        hlc: clock.now(),
        affectedNodeIds: [SOURCE_CLASS_ID],
        opType: "class.property.set",
        payload: { classId: SOURCE_CLASS_ID, propertySchemaId: COVER_PROPERTY_ID, sequence: 7 },
      }),
    );
  }
  if (envelopes.length > 0) {
    await ctx.client.postJson<{ savedCount: number }>("/api/relay/v2/batch", { envelopes });
  }
}

async function coverClearValue(ctx: CommandContext, nodeId: string, object: FullObject): Promise<string | null> {
  const assetId = coverAssetOf(object);
  if (assetId === null) return null;
  await deleteProperty(ctx, nodeId, COVER_PROPERTY_ID, 0);
  return assetId;
}

/**
 * `notees cover set <nodeId> <file>` / `--asset <assetNodeId>` — the one-gesture
 * cover: ensure family → (file: asset node + upload/attach | --asset: reuse a
 * node) → cover property + the asset class. Replaces an existing cover by
 * default (the old asset node survives as an asset); --skip-existing makes
 * scripts re-runnable (prints the existing asset id, no writes).
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
  await ensureCoverProperty(ctx);
  const object = await getObject(ctx, nodeId);

  const existing = coverAssetOf(object);
  if (existing !== null && options.skipExisting === true) {
    emit(ctx, `${existing}\n`, { pageId: nodeId, assetId: existing, created: false, replaced: false });
    return;
  }
  let replaced: string | null = null;
  if (existing !== null) {
    replaced = await coverClearValue(ctx, nodeId, object);
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
      presentAsMain: true,
      classIds: [ASSET_CLASS_ID],
    });
    assetId = created.id;
    await uploadAsset(ctx, file!, assetId);
  }
  await setProperty(ctx, nodeId, COVER_PROPERTY_ID, { nodeId: assetId }, 0);
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
  const cleared = await coverClearValue(ctx, nodeId, object);
  if (cleared === null) failUsage("node has no cover");
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
  "date",
  "date_range",
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
  scope: string;
  options: Array<{ id: string; label: string }> | null;
  targetClassFilter: string[] | null;
  datePrecision: string | null;
  dateQualified: boolean | null;
}

async function propertyList(ctx: CommandContext): Promise<void> {
  const body = await ctx.client.getJson<{ propertySchemas: ApiPropertySchema[] }>("/api/property-schemas");
  const rows = body.propertySchemas.map((schema) => [
    schema.name,
    schema.type,
    schema.multi ? "multi" : "",
    schema.scope,
    schema.id,
  ]);
  emit(ctx, `${formatTable([["NAME", "TYPE", "MULTI", "SCOPE", "ID"], ...rows])}\n`, body);
}

async function propertyGet(ctx: CommandContext, schemaRef: string): Promise<void> {
  const schema = await resolvePropertySchemaRef(ctx, schemaRef);
  const body = await ctx.client.getJson<{ propertySchema: ApiPropertySchema }>(
    `/api/property-schemas/${encodeURIComponent(schema.id)}`,
  );
  emit(ctx, `${JSON.stringify(body.propertySchema, null, 2)}\n`, body);
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
    scope: "global",
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

interface ClassPropertyFlags {
  sequence?: string;
  required?: boolean;
  readonly?: boolean;
  hideWhenEmpty?: boolean;
  default?: string;
}

/** `notees property bind` — the class.property.set patch: omitted flags keep
 * their stored values, `--no-<flag>` clears them (null), --default parses as JSON. */
async function propertyBind(
  ctx: CommandContext,
  classRef: string,
  schemaRef: string,
  options: ClassPropertyFlags,
): Promise<void> {
  const klass = await resolveClassRef(ctx, classRef);
  const schema = await resolvePropertySchemaRef(ctx, schemaRef);
  const body: Record<string, unknown> = { propertySchemaId: schema.id };
  if (options.sequence !== undefined) {
    const sequence = Number.parseInt(options.sequence, 10);
    if (!Number.isInteger(sequence) || sequence < 0) failUsage("--sequence must be a non-negative integer");
    body.sequence = sequence;
  }
  if (options.required !== undefined) body.required = options.required;
  if (options.readonly !== undefined) body.readonly = options.readonly;
  if (options.hideWhenEmpty !== undefined) body.hideWhenEmpty = options.hideWhenEmpty;
  if (options.default !== undefined) {
    try {
      body.defaultValue = JSON.parse(options.default) as unknown;
    } catch {
      failUsage("--default must be valid JSON (e.g. --default '\"n/a\"' or --default '42')");
    }
  }
  const res = await ctx.client.postJson<{ binding: unknown }>(
    `/api/classes/${encodeURIComponent(klass.id)}/properties`,
    body,
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
    scope: "class",
    ...(spec.options !== undefined ? { options: spec.options } : {}),
    ...(spec.targetClassFilter !== undefined
      ? { targetClassFilter: spec.targetClassFilter.map((className: SystemClassName) => SYSTEM_CLASS_UUIDS[className]) }
      : {}),
  });
}

async function importBibtex(ctx: CommandContext, filePath: string): Promise<void> {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new CliError(EXIT.usage, `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = parseBibtex(text);
  if (entries.length === 0) {
    throw new CliError(EXIT.domain, `no BibTeX entries found in ${filePath}`);
  }

  // Schemas the import may touch (citekey always; the rest only when used).
  const usedNames = new Set<SystemPropertyName>(["citekey"]);
  for (const entry of entries) {
    const fields = entry.fields;
    if (fields.doi !== undefined) usedNames.add("doi");
    if (fields.isbn !== undefined) usedNames.add("isbn");
    if (fields.url !== undefined) usedNames.add("url");
    if (fields.publisher !== undefined || fields.school !== undefined || fields.institution !== undefined) {
      usedNames.add("publisher");
    }
    if (fields.year !== undefined || fields.date !== undefined) usedNames.add("publicationDate");
    if (fields.author !== undefined || fields.editor !== undefined) usedNames.add("authors");
  }
  for (const name of usedNames) await ensurePropertySchema(ctx, name);

  const counts = { created: 0, updated: 0, persons: 0, personsCreated: 0 };
  const personIds = new Map<string, string>(); // literal name → person id (per-run dedupe)
  const importedIds: string[] = [];
  for (const entry of entries) {
    const spec = cslToNodeSpecs(bibToCsl(entry));
    // Authors are node-typed to agent nodes (SCHEMA.md "Citations", FINAL
    // owner decision 2026-09-27): find-or-create one person per name string.
    const authorIds: string[] = [];
    for (const literal of spec.authors) {
      if (literal.length === 0) continue;
      let personId = personIds.get(literal);
      if (personId === undefined) {
        personId = await findOrCreatePerson(ctx, literal, counts);
        personIds.set(literal, personId);
        counts.persons += 1;
      }
      authorIds.push(personId);
    }
    importedIds.push(await upsertSourceByCitekey(ctx, spec, authorIds, counts));
  }

  const machine = { ...counts, entries: importedIds };
  emit(
    ctx,
    `imported ${entries.length} entries: ${counts.created} created, ${counts.updated} updated, ` +
      `${counts.persons} persons (${counts.personsCreated} new)\n`,
    machine,
  );
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
      presentAsMain: true,
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
 *  print the day object; --append adds a text block to it. */
async function today(ctx: CommandContext, options: { append?: string }): Promise<void> {
  const iso = todayIsoLocal();
  const parts = parseIsoDate(iso);
  const ids = chainNodeIds(iso);
  await ensureChainNode(ctx, ids.year, dateNodeLabel(parts, "year"), SYSTEM_CLASS_UUIDS.year, null);
  await ensureChainNode(ctx, ids.month, dateNodeLabel(parts, "month"), SYSTEM_CLASS_UUIDS.month, ids.year);
  await ensureChainNode(ctx, ids.day, dateNodeLabel(parts, "day"), SYSTEM_CLASS_UUIDS.day, ids.month);
  if (options.append !== undefined && options.append.trim() !== "") {
    await ctx.client.postJson("/api/objects", {
      parentId: ids.day,
      contentAst: [{ type: "text", text: options.append }],
    });
  }
  const day = await getFullObject(ctx, ids.day);
  emit(ctx, `${JSON.stringify(day, null, 2)}\n`, day);
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
    presentAsMain: true,
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

async function upsertSourceByCitekey(
  ctx: CommandContext,
  spec: ReturnType<typeof cslToNodeSpecs>,
  authorIds: string[],
  counts: { created: number; updated: number },
): Promise<string> {
  const existing = await findSourceByCitekey(ctx, spec.citekey);
  let id: string;
  if (existing === undefined) {
    const created = await ctx.client.postJson<{ id: string }>("/api/objects", {
      presentAsMain: true,
      name: spec.title,
      classIds: [SYSTEM_CLASS_UUIDS[spec.className]],
    });
    id = created.id;
    counts.created += 1;
  } else {
    id = existing.id;
    counts.updated += 1;
    if (existing.name !== spec.title) {
      // Title-is-content: the title update rewrites the node's text content.
      await ctx.client.patchJson(`/api/objects/${encodeURIComponent(id)}`, {
        contentAst: [{ type: "text", text: spec.title }],
      });
    }
  }
  const properties = existing === undefined ? [] : fullPropertiesOf(existing);
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
  // Authors: node-typed list, replace wholesale — set the new {nodeId} refs,
  // unset the stale tail.
  const previousCount = properties.filter((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.authors).length;
  for (let idx = 0; idx < authorIds.length; idx += 1) {
    await setProperty(ctx, id, SYSTEM_PROPERTY_UUIDS.authors, { nodeId: authorIds[idx] }, idx);
  }
  for (let idx = authorIds.length; idx < previousCount; idx += 1) {
    await deleteProperty(ctx, id, SYSTEM_PROPERTY_UUIDS.authors, idx);
  }
  return id;
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

  // The `authors` property is node-typed ({nodeId} refs, agent-filtered) —
  // resolve every referenced author to its current display name up front,
  // batched through the objects API (the resolver caches per id). Date-node
  // refs (publicationDate) resolve through the same batch.
  const authorIds = new Set<string>();
  const dateRefIds = new Set<string>();
  for (const node of included.values()) {
    if (sourceClassOf(node.classIds) === undefined) continue;
    for (const property of node.properties) {
      if (property.schemaId !== SYSTEM_PROPERTY_UUIDS.authors) continue;
      if (isRecord(property.value) && typeof property.value.nodeId === "string") {
        authorIds.add(property.value.nodeId);
      }
    }
    const pub = node.properties.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.publicationDate);
    if (pub !== undefined && isRecord(pub.value) && typeof pub.value.nodeId === "string") {
      dateRefIds.add(pub.value.nodeId);
    }
  }
  const authorNames = new Map<string, string>();
  for (const authorId of authorIds) {
    const authorNode = await resolver.getObject(authorId);
    if (authorNode === undefined) continue;
    const displayName = deriveDisplayName(authorNode) || authorNode.name?.trim() || "";
    if (displayName.length > 0) authorNames.set(authorId, displayName);
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
    const authors = node.properties
      .filter((property) => property.schemaId === SYSTEM_PROPERTY_UUIDS.authors)
      .map((property) =>
        isRecord(property.value) && typeof property.value.nodeId === "string"
          ? authorNames.get(property.value.nodeId)
          : undefined,
      )
      .filter((name): name is string => name !== undefined);
    rendered.push(
      serializeBibEntry(
        cslToBib(nodeToCsl(node, node.properties, authors, (refId) => dateNames.get(refId))),
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
  const { server, workspace } = requireServer(opts);
  const statePath = defaultStatePath();
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

function buildProgram(): Command {
  const program = new Command();
  program
    .name("notees")
    .description("Notees CLI")
    .version(CLI_VERSION)
    .option("--json", "stable machine-readable output")
    .option("--server <url>", "server base URL (env NOTEES_SERVER)")
    .option("--key <credential>", "operator key, user API key, or session token (env NOTEES_API_KEY)")
    .option("--workspace <name|id>", "workspace for the object API (env NOTEES_WORKSPACE; default: the server's default workspace)", undefined)
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
    .option("--isClass", "declare a class node (a root: no --parent/--class/--presentAsMain)")
    .option(
      "--presentAsMain",
      "render bit: set for the parent's main-children zone (server default: true when parentless, false when parented)",
      undefined,
    )
    .option("--name <name>", "object name")
    .option(
      "--content <json>",
      "contentAst token array for rich content (mentions, external links, …; mutually exclusive with --name)",
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

  const cover = program.command("cover").description("node covers — the one-gesture image cover (family ensure + asset node + property)");
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
    .description("show one property schema (schema: uuid or name)")
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
    .action(async (name: string, options: { type?: string; multi?: boolean; option?: string[]; targetClass?: string[]; pad?: string; decimals?: string; rounding?: string }, command: Command) => {
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
      "bind a property schema to a class (class.property.set; class/schema: uuid or title/name; " +
        "omitted flags keep their values, --no-<flag> clears)",
    )
    .option("--sequence <n>", "binding order within the class")
    .addOption(new Option("--required", "mark the binding required").default(undefined))
    .addOption(new Option("--no-required", "clear the required flag"))
    .addOption(new Option("--readonly", "mark the binding read-only").default(undefined))
    .addOption(new Option("--no-readonly", "clear the read-only flag"))
    .addOption(new Option("--hideWhenEmpty", "hide the row while unvalued").default(undefined))
    .addOption(new Option("--no-hideWhenEmpty", "clear the hide-when-empty flag"))
    .option("--default <json>", "binding default value (JSON; a wrong-typed default is rejected)")
    .action(async (classRef: string, schemaRef: string, options: ClassPropertyFlags, command: Command) => {
      await propertyBind(ctxOf(command), classRef, schemaRef, options);
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
      new Option("--presentAsMain", "create with the render bit set (main-children zone)").default(undefined),
    )
    .addOption(new Option("--no-presentAsMain", "create with the render bit unset (inline body)"))
    .action(async (options: { name?: string; class?: string[]; parent?: string; presentAsMain?: boolean }, command: Command) => {
      await objectUpsert(ctxOf(command), options);
    });
  object
    .command("update <id>")
    .description("update an object")
    .option("--name <name>", "new name")
    .option(
      "--content <json>",
      "replace the node's content with this contentAst token array (mentions, external links, …; mutually exclusive with --name)",
    )
    .addOption(
      new Option("--presentAsMain", "promote: render the node in its parent's main-children zone").default(
        undefined,
      ),
    )
    .addOption(new Option("--no-presentAsMain", "demote: render the node in the inline body"))
    .option("--icon <icon>", "icon")
    .option("--color <color>", "color: preset token (red…gray) or #RRGGBB; 'none' clears")
    .action(async (id: string, options: { name?: string; presentAsMain?: boolean; icon?: string; color?: string }, command: Command) => {
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
        "--presentAsMain",
        "filter: document-chrome rows (non-class roots + main children — the pages-ish listing)",
      ).default(undefined),
    )
    .addOption(
      new Option("--no-presentAsMain", "filter: inline-body blocks (parented rows with the render bit unset)"),
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
      "search — plain text (FTS) or the query language: class:Name (name or uuid), isClass:true|false, presentAsMain:true|false, " +
        "prop:name:<op>value (:= != :> :>= :< :<=, bare : = contains, no value = exists; schema by name or uuid), " +
        "bare schema fields (year:>2010), text:term, linked:Name (name or uuid), \"quoted phrases\", AND OR NOT, ( )",
    )
    .addOption(new Option("--isClass", "filter: class nodes only (plain-text search only)").default(undefined))
    .addOption(new Option("--no-isClass", "filter: non-class nodes only (plain-text search only)"))
    .addOption(
      new Option("--presentAsMain", "filter: document-chrome rows only (plain-text search only)").default(undefined),
    )
    .addOption(
      new Option("--no-presentAsMain", "filter: inline-body blocks only (plain-text search only)"),
    )
    .action(async (queryText: string, options: { isClass?: boolean; presentAsMain?: boolean }, command: Command) => {
      await search(ctxOf(command), queryText, options);
    });

  program
    .command("today")
    .description("open today's daily note — ensures the local date chain and the day page, prints it")
    .option("--append <text>", "append a text block to the daily note")
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
    .description("list classes")
    .action(async (_options: object, command: Command) => {
      await classList(ctxOf(command));
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

  const importCmd = program.command("import").description("import operations");
  importCmd
    .command("bibtex <file>")
    .description("import a .bib file (find-or-create author persons, upsert sources by citekey)")
    .action(async (filePath: string, _options: object, command: Command) => {
      await importBibtex(ctxOf(command), filePath);
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

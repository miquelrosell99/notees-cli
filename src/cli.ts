#!/usr/bin/env node
/**
 * `notees` — the Notees v2 CLI.
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError, Option } from "commander";

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
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
  serializeBibEntry,
  sourceClassOf,
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
import { runShell } from "./shell.js";
import { defaultStatePath, serverState, updateServerState, type StoredCredential } from "./state.js";
import { formatTable, queryString, readStdin } from "./util.js";
import { DEFAULT_WORKSPACE_ID, deriveUuid } from "./uuid.js";

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

async function objectCreate(ctx: CommandContext, options: {
  presentAsMain?: boolean;
  isClass?: boolean;
  name?: string;
  class?: string[];
  parent?: string;
  stdin?: boolean;
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
  const created = await ctx.client.postJson<{ id: string; object: unknown }>("/api/objects", body);
  // Non-json prints the new id only (script-friendly).
  emit(ctx, `${created.id}\n`, created);
}

async function objectUpdate(ctx: CommandContext, id: string, options: {
  name?: string;
  presentAsMain?: boolean;
  icon?: string;
  color?: string;
}): Promise<void> {
  const body: Record<string, unknown> = {};
  // Title-is-content: --name rewrites the node's text content (its title).
  if (options.name !== undefined) {
    body.contentAst = [{ type: "text", text: options.name }];
  }
  // Promotion/demotion: flip the render bit between the parent's
  // main-children zone (true) and the inline body (false).
  if (options.presentAsMain !== undefined) body.presentAsMain = options.presentAsMain;
  if (options.icon !== undefined) body.icon = options.icon;
  if (options.color !== undefined) body.color = options.color;
  if (Object.keys(body).length === 0) {
    failUsage("object update requires at least one of --name, --presentAsMain, --icon, --color");
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
 * the derived-store runtime, which lives server-side.
 */
async function compileQueryLanguage(ctx: CommandContext, text: string): Promise<QueryAst> {
  const [{ classes }, { propertySchemas }] = await Promise.all([
    ctx.client.getJson<{ classes: { id: string; name: string }[] }>("/api/classes"),
    ctx.client.getJson<{ propertySchemas: { id: string; name: string }[] }>("/api/property-schemas"),
  ]);
  const classIds = new Map(classes.map((klass) => [klass.name.toLowerCase(), klass.id]));
  const schemaIds = new Map(propertySchemas.map((schema) => [schema.name.toLowerCase(), schema.id]));

  // linked:<name> resolution: the search endpoint, exact-name match.
  const nodeIds = new Map<string, string>();
  for (const name of extractLinkedNames(text)) {
    const wanted = name.toLowerCase();
    if (nodeIds.has(wanted)) continue;
    const query = queryString({ q: name, limit: 50 });
    const body = await ctx.client.getJson<{ results: { id: string; name: string | null }[] }>(
      `/api/search${query}`,
    );
    const hit = body.results.find((result) => (result.name ?? "").toLowerCase() === wanted);
    if (hit !== undefined) nodeIds.set(wanted, hit.id);
  }

  try {
    return parseQueryLanguage(text, {
      resolvers: {
        resolveClass: (name) => classIds.get(name.toLowerCase()),
        resolvePropertySchema: (name) => schemaIds.get(name.toLowerCase()),
        resolveNode: (name) => nodeIds.get(name.toLowerCase()),
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
 * `notees class remap <from> <to>` — the bulk membership migration verb: move
 * every member of FROM to TO (assign + unassign, idempotent ops), remap
 * extends edges pointing at FROM onto TO, leave the emptied FROM class in
 * place (deletion is a separate, deliberate step). Preview-first like the
 * destructive commands: without --yes it prints the blast radius and exits 2;
 * --dry-run prints it and exits 0.
 */
async function classRemap(
  ctx: CommandContext,
  fromRef: string,
  toRef: string,
  options: { dryRun?: boolean; yes?: boolean },
): Promise<void> {
  const from = await resolveClassRef(ctx, fromRef);
  const to = await resolveClassRef(ctx, toRef);
  if (from.id === to.id) failUsage("class remap: from and to are the same class");
  const fromDetail = await ctx.client.getJson<{ members: Array<{ id: string }> }>(
    `/api/classes/${encodeURIComponent(from.id)}`,
  );
  const { classes } = await ctx.client.getJson<{
    classes: Array<{ id: string; parentClassIds: string[] }>;
  }>("/api/classes");
  // An extender equal to the target is skipped: remap cannot make TO extend itself.
  const extenders = classes.filter((c) => (c.parentClassIds ?? []).includes(from.id) && c.id !== to.id);
  const plan = {
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
    members: fromDetail.members.length,
    extenders: extenders.length,
  };
  const preview = `${plan.members} members of "${from.name}" → "${to.name}", ${plan.extenders} extends edges remapped (the emptied class stays)`;
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
  for (const member of fromDetail.members) {
    try {
      await ctx.client.putJson(`/api/objects/${encodeURIComponent(member.id)}/classes/${encodeURIComponent(to.id)}`);
      await ctx.client.deleteJson(
        `/api/objects/${encodeURIComponent(member.id)}/classes/${encodeURIComponent(from.id)}`,
      );
      moved += 1;
    } catch (error) {
      failures.push({ id: member.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
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

async function backlinks(ctx: CommandContext, id: string): Promise<void> {
  const body = await ctx.client.getJson<unknown>(`/api/objects/${encodeURIComponent(id)}/backlinks`);
  emit(ctx, `${JSON.stringify(body, null, 2)}\n`, body);
}

async function assetAdd(ctx: CommandContext, filePath: string, options: { object?: string }): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new CliError(EXIT.usage, `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const form = new FormData();
  form.append("file", new Blob([bytes]), basename(filePath));
  if (options.object !== undefined) form.append("objectId", options.object);
  const body = await ctx.client.postMultipart<{ assetId: string }>("/api/assets", form);
  emit(ctx, `${body.assetId}\n`, body);
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
 * direct referrers only), per §34.16.3; default 3. */
function parseDepth(options: { depth?: string; fixpoint?: boolean }): number {
  if (options.fixpoint === true) return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(options.depth ?? "3", 10);
  if (!Number.isInteger(parsed) || parsed < 0) failUsage("--depth must be a non-negative integer");
  return parsed;
}

function requireExportSelectors(command: string, options: { ids?: string[]; linkedTo?: string | undefined }): string[] {
  const ids = options.ids ?? [];
  if (ids.length === 0 && options.linkedTo === undefined) {
    failUsage(`${command} requires --ids <uuid...> or --linked-to <uuid>`);
  }
  if (ids.length > 0 && options.linkedTo !== undefined) {
    failUsage("--ids and --linked-to are mutually exclusive");
  }
  return ids;
}

async function exportMarkdown(ctx: CommandContext, options: {
  ids?: string[];
  linkedTo?: string;
  depth?: string;
  fixpoint?: boolean;
  outputDir?: string;
  stdout?: boolean;
}): Promise<void> {
  const ids = requireExportSelectors("export markdown", options);
  if (options.outputDir !== undefined && options.stdout === true) {
    failUsage("--output-dir and --stdout are mutually exclusive");
  }
  if (options.outputDir === undefined && options.stdout !== true) {
    failUsage("export markdown requires --output-dir <dir> or --stdout");
  }
  const depth = parseDepth(options);
  // Seeds + closure + children + reference names live in markdown-export.ts,
  // shared with the shell's export(ids) helper.
  const bundle = await buildMarkdownBundle(ctx.client, { ids, linkedTo: options.linkedTo, depth });
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

/**
 * Get-or-create a property schema by its fixed system UUID (all replicas
 * converge on the same ids). Seeded workspaces already carry the
 * bibliographic schemas, so the create path only fires for unseeded ones.
 *
 * M1 drift note (no migration): workspaces seeded during the brief
 * 2026-09-27 text-authors window carry `authors` as text-multi from that
 * seed spec. The fixed UUID matches, so this get-or-create is a no-op
 * there and the stored row keeps its old type (throwaway M1 data).
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

/** M1 person match: exact display name via the objects?q= title search. */
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
    await setIfChanged(SYSTEM_PROPERTY_UUIDS.publicationDate, spec.publicationDate);
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
  // batched through the objects API (the resolver caches per id).
  const authorIds = new Set<string>();
  for (const node of included.values()) {
    if (sourceClassOf(node.classIds) === undefined) continue;
    for (const property of node.properties) {
      if (property.schemaId !== SYSTEM_PROPERTY_UUIDS.authors) continue;
      if (isRecord(property.value) && typeof property.value.nodeId === "string") {
        authorIds.add(property.value.nodeId);
      }
    }
  }
  const authorNames = new Map<string, string>();
  for (const authorId of authorIds) {
    const authorNode = await resolver.getObject(authorId);
    if (authorNode === undefined) continue;
    const displayName = deriveDisplayName(authorNode) || authorNode.name?.trim() || "";
    if (displayName.length > 0) authorNames.set(authorId, displayName);
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
    rendered.push(serializeBibEntry(cslToBib(nodeToCsl(node, node.properties, authors))));
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
    .description("Notees v2 CLI")
    .version("2.0.0-m1")
    .option("--json", "stable machine-readable output")
    .option("--server <url>", "server base URL (env NOTEES_SERVER)")
    .option("--key <credential>", "operator key, user API key, or session token (env NOTEES_API_KEY)")
    .option("--workspace <name|id>", "workspace for the object API (env NOTEES_WORKSPACE; default: the server's default workspace)", undefined)
    .option("--profile <name>", "profile name for local state", "default")
    .exitOverride();

  const object = program.command("object").description("object operations");
  object
    .command("get <id>")
    .description("fetch an object")
    .action(async (id: string, _options: object, command: Command) => {
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
    .option("--class <id>", "class id (repeatable)", (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option("--parent <id>", "parent object id")
    .option("--stdin", "read the object body as JSON from stdin")
    .action(async (options: object, command: Command) => {
      await objectCreate(ctxOf(command), options);
    });
  object
    .command("update <id>")
    .description("update an object")
    .option("--name <name>", "new name")
    .addOption(
      new Option("--presentAsMain", "promote: render the node in its parent's main-children zone").default(
        undefined,
      ),
    )
    .addOption(new Option("--no-presentAsMain", "demote: render the node in the inline body"))
    .option("--icon <icon>", "icon")
    .option("--color <color>", "color")
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
      "search — plain text (FTS) or the query language: class:Name, isClass:true|false, presentAsMain:true|false, " +
        "prop:name:<op>value (:= != :> :>= :< :<=, bare : = contains, no value = exists), " +
        "bare schema fields (year:>2010), text:term, linked:Name, \"quoted phrases\", AND OR NOT, ( )",
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
        "the emptied class stays; requires --yes, preview without it, --dry-run to inspect)",
    )
    .option("--dry-run", "print what would move and exit 0 without writing", false)
    .option("--yes", "confirm the bulk remap", false)
    .action(async (fromRef: string, toRef: string, options: { dryRun?: boolean; yes?: boolean }, command: Command) => {
      await classRemap(ctxOf(command), fromRef, toRef, options);
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
    .command("shell")
    .description("interactive object-API shell (Node REPL with helpers; piped stdin runs as a script)")
    .action(async (_options: object, command: Command) => {
      const ctx = ctxOf(command);
      await runShell({ client: ctx.client, io: ctx.io, json: ctx.opts.json === true, stdin: ctx.io.stdin });
    });

  const exportCmd = program.command("export").description("export operations");
  exportCmd
    .command("markdown")
    .description("export objects as Markdown (<uuid>.md files + notees-manifest.json)")
    .addOption(new Option("--ids <uuid...>", "export exactly these object ids (no closure)"))
    .option("--linked-to <uuid>", "export the seed plus the pages that transitively link to it")
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
          depth?: string;
          fixpoint?: boolean;
          outputDir?: string;
          stdout?: boolean;
        },
        command: Command,
      ) => {
        await exportMarkdown(ctxOf(command), options);
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

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
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

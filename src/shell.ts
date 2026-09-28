/**
 * `notees shell` — the Odoo-shell equivalent for Notees v2: a Node REPL with
 * the object API preloaded for arbitrary graph scripting.
 *
 * Two modes, chosen by stdin:
 * - TTY: interactive REPL (`notees> ` prompt, top-level await, `.help` banner).
 * - piped: stdin is read as one script, executed with the helpers in scope,
 *   then the process exits — 0 on success, 1 on script error. This is the
 *   agent/script path: `echo 'const p = await create({…}); console.log(p.id)' |
 *   notees shell --server … --key …`.
 *
 * Startup probes the server doctor-style: reachability (`GET /api/v1/version`,
 * public) then key validity (an authenticated read). Failure prints a clear
 * message and exits with the mapped code (network → 5, auth → 3), matching
 * the CLI's exit-code contract. `--json` switches the REPL's result writer to
 * single-line JSON instead of the inspect pretty-printer.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import repl from "node:repl";
import { format } from "node:util";
import vm from "node:vm";

import { concatBundleMarkdown } from "@notees/export";

import type { ApiClient } from "./client.js";
import { CliError, EXIT } from "./exit-codes.js";
import { buildMarkdownBundle } from "./markdown-export.js";
import { queryString, readStdin } from "./util.js";

export interface ShellIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface ShellOptions {
  client: ApiClient;
  io: ShellIo;
  json: boolean;
  stdin?: NodeJS.ReadableStream | undefined;
}

export interface ListOptions {
  nodeType?: "page" | "block" | "class";
  class?: string;
  q?: string;
  property?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchOptions {
  nodeType?: "page" | "block" | "class";
  limit?: number;
}

export interface DeleteOptions {
  permanent?: boolean;
}

export interface SetPropertyOptions {
  idx?: number;
  metadata?: Record<string, unknown>;
}

/** The preloaded shell surface (also the script-mode global scope). */
export interface ShellHelpers {
  /** The raw typed HTTP client — the full API surface for anything the helpers don't wrap. */
  api: ApiClient;
  get(id: string): Promise<unknown>;
  list(opts?: ListOptions): Promise<unknown>;
  search(q: string, opts?: SearchOptions): Promise<unknown>;
  classes(): Promise<unknown>;
  classInfo(id: string): Promise<unknown>;
  backlinks(id: string): Promise<unknown>;
  props(id: string): Promise<unknown>;
  effective(id: string): Promise<unknown>;
  create(partial: Record<string, unknown>): Promise<unknown>;
  update(id: string, fields: Record<string, unknown>): Promise<unknown>;
  del(id: string, opts?: DeleteOptions): Promise<unknown>;
  setProperty(id: string, schemaId: string, value: unknown, opts?: SetPropertyOptions): Promise<unknown>;
  upload(filePath: string): Promise<string>;
  /** Markdown bundle text for the given object ids. `export` is a reserved
   * word in JS, so the callable alias is `exportMd`; the spec-named property
   * stays reachable as `helpers.export(ids)` in scripts / `globalThis.export`
   * in the REPL. */
  export(ids: string[]): Promise<string>;
  exportMd(ids: string[]): Promise<string>;
}

const HELP_TEXT = `notees shell helpers (object API, top-level await works):
  api                                        raw ApiClient: getJson/postJson/patchJson/deleteJson/postMultipart, .server, .apiKey
  get(id)                                    fetch an object (contentAst + authored properties)
  list(opts?)                                list objects -> array (opts: nodeType, class, q, property, limit, cursor)
  search(q, opts?)                           full-text search -> results array (opts: nodeType, limit)
  classes()                                  list classes
  classInfo(id)                              one class (with members) merged into a single object
  backlinks(id)                              edges pointing at id
  props(id)                                  authored properties of an object
  effective(id)                              authored + class-default effective properties
  create(partial)                            POST /objects -> created object (fields: nodeType, name, contentAst, classIds, parentId)
  update(id, fields)                         PATCH fields (name, nodeType, icon, color, contentAst) -> updated object
  del(id, opts?)                             delete; opts.permanent = true for a hard delete (auto-confirms the id)
  setProperty(id, schemaId, value, opts?)    set a property (opts: idx, metadata) -> updated object
  upload(filePath)                           upload a file from disk -> asset id
  exportMd(ids) (alias: export)              markdown bundle text for the given object ids
Type .help to see this again, .exit (or Ctrl-D) to quit.`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildHelpers(client: ApiClient): ShellHelpers {
  const objectUrl = (id: string): string => `/api/v1/objects/${encodeURIComponent(id)}`;
  // `export` is a reserved word — not callable from plain script/REPL syntax,
  // so the ergonomic entry point is the exportMd alias (same function).
  const exportMarkdown = async (ids: string[]): Promise<string> => {
    const bundle = await buildMarkdownBundle(client, { ids, depth: 3 });
    return concatBundleMarkdown(bundle);
  };
  return {
    api: client,
    get: async (id) => (await client.getJson<{ object: unknown }>(objectUrl(id))).object,
    list: async (opts = {}) => {
      const query = queryString({
        nodeType: opts.nodeType,
        class: opts.class,
        q: opts.q,
        property: opts.property,
        limit: opts.limit,
        cursor: opts.cursor,
      });
      const body = await client.getJson<{ objects: unknown[] }>(`/api/v1/objects${query}`);
      return body.objects;
    },
    search: async (q, opts = {}) => {
      const query = queryString({ q, nodeType: opts.nodeType, limit: opts.limit });
      const body = await client.getJson<{ results: unknown[] }>(`/api/v1/search${query}`);
      return body.results;
    },
    classes: async () => (await client.getJson<{ classes: unknown[] }>("/api/v1/classes")).classes,
    classInfo: async (id) => {
      const body = await client.getJson<{ class: Record<string, unknown>; members: unknown[] }>(
        `/api/v1/classes/${encodeURIComponent(id)}`,
      );
      return { ...body.class, members: body.members };
    },
    backlinks: async (id) =>
      (await client.getJson<{ backlinks: unknown[] }>(`${objectUrl(id)}/backlinks`)).backlinks,
    props: async (id) => {
      const body = await client.getJson<{ object: { properties?: unknown[] } }>(objectUrl(id));
      return body.object.properties ?? [];
    },
    effective: async (id) =>
      (await client.getJson<{ properties: unknown[] }>(`${objectUrl(id)}/effective-properties`)).properties,
    create: async (partial) =>
      (await client.postJson<{ object: unknown }>("/api/v1/objects", partial)).object,
    update: async (id, fields) =>
      (await client.patchJson<{ object: unknown }>(objectUrl(id), fields)).object,
    del: async (id, opts = {}) => {
      const permanent = opts.permanent === true;
      const query = permanent ? `?permanent=true&confirm=${encodeURIComponent(id)}` : "";
      return client.deleteJson<{ id: string; deleted: boolean; permanent: boolean }>(
        `${objectUrl(id)}${query}`,
      );
    },
    setProperty: async (id, schemaId, value, opts = {}) =>
      (
        await client.postJson<{ object: unknown }>(`${objectUrl(id)}/properties`, {
          propertySchemaId: schemaId,
          value,
          idx: opts.idx ?? 0,
          ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
        })
      ).object,
    upload: async (filePath) => {
      const bytes = readFileSync(filePath);
      const form = new FormData();
      form.append("file", new Blob([bytes]), basename(filePath));
      const body = await client.postMultipart<{ assetId: string }>("/api/v1/assets", form);
      return body.assetId;
    },
    export: exportMarkdown,
    exportMd: exportMarkdown,
  };
}

/** Doctor-style startup probe: reachability first (public route), then key validity (authenticated read). */
async function probe(client: ApiClient): Promise<void> {
  try {
    await client.getJson<{ name: string; version: string }>("/api/v1/version");
  } catch (error) {
    throw new CliError(
      error instanceof CliError ? error.exitCode : EXIT.network,
      `shell: server at ${client.server} unreachable (${errorMessage(error)})`,
    );
  }
  try {
    await client.getJson<unknown>("/api/v1/classes");
  } catch (error) {
    throw new CliError(
      error instanceof CliError ? error.exitCode : EXIT.auth,
      `shell: authentication failed (${errorMessage(error)})`,
    );
  }
}

// --- async eval (top-level await) ------------------------------------------------

const DECLARATION_LINE = /^\s*(?:const|let|var)\s+([^\n=]+?)\s*(?:=|$)/;
const FUNCTION_LINE = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const CLASS_LINE = /^\s*class\s+([A-Za-z_$][\w$]*)/;

function identifiersOf(pattern: string): string[] {
  return pattern
    .replace(/[{}[\]]/g, " ")
    .split(",")
    .map((part) => part.trim().split("=")[0]!.trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "{") delta += 1;
    else if (char === "}") delta -= 1;
  }
  return delta;
}

/** Naive delimiter balance (REPL-grade; string literals with brackets can fool it). */
function delimitersBalanced(code: string): boolean {
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (const char of code) {
    if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    if (parens < 0 || brackets < 0 || braces < 0) return false;
  }
  return parens === 0 && brackets === 0 && braces === 0;
}

/**
 * Find top-level (brace-depth 0) declarations and return the same code plus
 * the declared names, so the eval wrapper can copy them onto the context —
 * stock-REPL semantics for `const p = await create(…)` followed by `p.id` on
 * the next line. Naive by design (REPL-grade): string literals containing
 * braces can confuse depth, and block-scoped declarations inside a line-0
 * block are not hoisted.
 */
function topLevelDeclarations(code: string): { code: string; names: string[] } {
  const names: string[] = [];
  let depth = 0;
  for (const line of code.split("\n")) {
    if (depth === 0) {
      const decl = DECLARATION_LINE.exec(line);
      if (decl !== null) {
        names.push(...identifiersOf(decl[1]!));
      } else {
        const fn = FUNCTION_LINE.exec(line);
        const cls = CLASS_LINE.exec(line);
        const named = fn ?? cls;
        if (named !== null) names.push(named[1]!);
      }
    }
    depth += braceDelta(line);
  }
  return { code, names };
}

function runAsyncWrapper(source: string, context: vm.Context, filename: string): Promise<unknown> {
  const script = new vm.Script(source, { filename });
  const result: unknown = script.runInContext(context, { breakOnSigint: true });
  return Promise.resolve(result);
}

/**
 * REPL eval with top-level await. Two attempts per line: an expression wrap
 * (value echoed, nothing to persist) and a statement wrap with top-level
 * declaration hoisting. Incomplete input errors with repl.Recoverable so the
 * prompt continues on the next line, like the stock evaluator.
 */
const RECOVERABLE_SYNTAX =
  /unexpected end of input|missing \) after argument list|unterminated (?:string|template)|unexpected token '\)'/i;

function toReplError(error: unknown): Error {
  if (error instanceof SyntaxError && RECOVERABLE_SYNTAX.test(error.message)) {
    return new repl.Recoverable(error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function failLine(callback: (err: Error | null, result?: unknown) => void, error: unknown): void {
  callback(toReplError(error), undefined);
}

function makeAsyncEval(): repl.REPLEval {
  return (cmd, context, filename, callback) => {
    const trimmed = cmd.trim();
    if (trimmed.length === 0) {
      callback(null, undefined);
      return;
    }
    if (delimitersBalanced(trimmed)) {
      try {
        // Expression fast path: `await get(id)`, `api.server`, `1 + 1`, …
        const expression = runAsyncWrapper(`(async () => (${trimmed}))()`, context, filename);
        expression.then(
          (value) => callback(null, value),
          (error: unknown) => failLine(callback, error),
        );
        return;
      } catch {
        // Not an expression (declarations, statements, loops) — fall through.
      }
    }
    const { code, names } = topLevelDeclarations(cmd);
    const hoist = names.map((name) => `globalThis[${JSON.stringify(name)}] = ${name};`).join("\n");
    try {
      const statement = runAsyncWrapper(
        `(async () => {\n${code}\n${hoist}\n})()`,
        context,
        filename,
      );
      statement.then(
        () => callback(null, undefined),
        (error: unknown) => failLine(callback, error),
      );
    } catch (error) {
      failLine(callback, error);
    }
  };
}

// --- modes ----------------------------------------------------------------------

/** Run piped stdin as one script. Throws CliError(EXIT.domain) on script failure. */
async function runScript(helpers: ShellHelpers, options: ShellOptions): Promise<void> {
  const source = await readStdin({ stdin: options.stdin });
  // runInThisContext keeps the real Node globals (Buffer, process, …) but sees
  // only globals, so the helpers (and a console bound to the injected io, so
  // script output respects --json-style capture) are anchored on globalThis
  // for the wrapper to pick up. `export` is a JS reserved word and cannot be
  // a parameter, so it is excluded and the whole helpers object is passed as
  // `helpers` — the script calls it as `helpers.export(…)` (or `exportMd(…)`).
  const { stdout, stderr } = options.io;
  const scriptConsole = {
    log: (...args: unknown[]) => stdout.write(`${format(...args)}\n`),
    info: (...args: unknown[]) => stdout.write(`${format(...args)}\n`),
    debug: (...args: unknown[]) => stdout.write(`${format(...args)}\n`),
    warn: (...args: unknown[]) => stderr.write(`${format(...args)}\n`),
    error: (...args: unknown[]) => stderr.write(`${format(...args)}\n`),
  };
  const slot = "__noteesShellGlobals";
  const globals = globalThis as Record<string, unknown>;
  globals[slot] = { helpers, console: scriptConsole };
  try {
    const names = Object.keys(helpers).filter((name) => name !== "export");
    const params = [...names, "helpers", "console"].join(", ");
    const args = [
      ...names.map((name) => `${slot}.helpers[${JSON.stringify(name)}]`),
      `${slot}.helpers`,
      `${slot}.console`,
    ].join(", ");
    const wrapper = `((${params}) => (async () => {\n${source}\n})())(${args})`;
    const script = new vm.Script(wrapper, { filename: "<stdin>" });
    await script.runInThisContext({ breakOnSigint: true });
  } catch (error) {
    throw new CliError(EXIT.domain, `shell: script failed: ${errorMessage(error)}`);
  } finally {
    delete globals[slot];
  }
}

function startRepl(
  helpers: ShellHelpers,
  client: ApiClient,
  options: ShellOptions,
  stdin: NodeJS.ReadableStream,
): Promise<number> {
  return new Promise((resolve) => {
    const server = repl.start({
      prompt: "notees> ",
      input: stdin,
      output: options.io.stdout as unknown as NodeJS.WritableStream,
      terminal: true,
      eval: makeAsyncEval(),
      ignoreUndefined: true,
      // Human mode keeps the stock inspect writer; --json switches to
      // single-line JSON so results stay machine-shaped.
      ...(options.json
        ? { writer: (value: unknown) => (value === undefined ? "undefined" : JSON.stringify(value)) }
        : {}),
    });
    Object.assign(server.context, helpers);
    server.defineCommand("help", {
      help: "list the notees shell helpers",
      action() {
        this.output.write(`${HELP_TEXT}\n`);
        this.displayPrompt();
      },
    });
    server.on("exit", () => resolve(EXIT.ok));
    options.io.stdout.write(
      `notees shell — connected to ${client.server}. Top-level await works; .help lists the helpers, .exit quits.\n`,
    );
  });
}

/**
 * Entry point for the `shell` command: probe, then REPL (TTY) or script (piped).
 * Resolves EXIT.ok on clean exit (script success or REPL quit); throws CliError
 * on probe or script failure — the CliError exitCode is the process exit code.
 */
export async function runShell(options: ShellOptions): Promise<number> {
  await probe(options.client);
  const helpers = buildHelpers(options.client);
  const stdin = options.stdin ?? process.stdin;
  if ((stdin as { isTTY?: boolean }).isTTY === true) {
    return startRepl(helpers, options.client, options, stdin);
  }
  await runScript(helpers, options);
  return EXIT.ok;
}

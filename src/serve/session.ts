import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { SOURCE_CLASS_IDS, sourceClassOf, yearFromDate } from "@notees/export";

import { CliError, EXIT } from "../exit-codes.js";
import { openLocalWorkspace, type LocalWorkspace } from "../local-workspace.js";
import type { SearchResultItem } from "./protocol.js";

/** Held lock-file fds, by lock path (module-level so close() can release). */
const SERVE_LOCK_FDS = new Map<string, number>();

/**
 * The serve lock: one live bridge per workspace store. A second `notees
 * serve` on the same store would race the derived projection (two engines
 * rewriting one SQLite file), so the loser exits 4 (conflict). The file
 * carries the holder pid; a stale lock (holder dead) is stolen. Crash
 * residue is cleaned by the next successful acquire.
 */
function acquireServeLock(lockPath: string): void {
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    SERVE_LOCK_FDS.set(lockPath, fd);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (Number.isInteger(holder) && holder > 1 && isProcessAlive(holder)) {
      throw new CliError(EXIT.conflict, `another notees serve holds this workspace store (pid ${holder})`);
    }
    rmSync(lockPath, { force: true });
    acquireServeLock(lockPath);
  }
}

function releaseServeLock(lockPath: string): void {
  const fd = SERVE_LOCK_FDS.get(lockPath);
  if (fd !== undefined) {
    closeSync(fd);
    SERVE_LOCK_FDS.delete(lockPath);
  }
  rmSync(lockPath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface BridgeSessionOptions {
  server: string;
  apiKey: string;
  workspaceId: string;
  storeDir: string;
  statePath: string;
  stateKey: string;
  syncIntervalMs: number;
  onWarning(message: string): void;
}

export interface BridgeSession {
  readonly local: LocalWorkspace;
  /** FTS over the local derived store, filtered to the source class family. */
  searchSources(query: string, limit?: number): SearchResultItem[];
  close(): void;
}

export async function openBridgeSession(options: BridgeSessionOptions): Promise<BridgeSession> {
  // The lock file lives in the store dir, which openLocalWorkspace would
  // create only after we lock — create it here so a first run on a fresh
  // store dir cannot ENOENT the lock acquire.
  mkdirSync(options.storeDir, { recursive: true });
  const lockPath = join(options.storeDir, `${options.workspaceId}.serve.lock`);
  acquireServeLock(lockPath);
  let local: LocalWorkspace;
  try {
    local = await openLocalWorkspace({
      server: options.server,
      apiKey: options.apiKey,
      workspaceId: options.workspaceId,
      storeDir: options.storeDir,
      statePath: options.statePath,
      stateKey: options.stateKey,
      // Offline-first: a reachable store with an unreachable server still
      // serves the last synced projection (Word works with no network).
      bestEffortSync: true,
      onWarning: options.onWarning,
    });
  } catch (error) {
    releaseServeLock(lockPath);
    throw error;
  }
  const syncTimer = setInterval(() => {
    local.sync().catch((error: unknown) => {
      options.onWarning(`background sync failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, options.syncIntervalMs);
  syncTimer.unref();
  return {
    local,
    searchSources(query, limit = 20) {
      // class:source + FTS over the local derived store, executed through
      // @notees/query's executor (LocalWorkspace.runQueryAst) — the normative
      // interface — not a hand-rolled SQL filter. The target carries the
      // `source` base id plus the whole roster: member-in is
      // extends-closure membership, but the roster ids are listed explicitly
      // too so subclass-only nodes match even where a store predates the
      // extends edges. Keystroke tokens are quoted so raw input can never
      // break the FTS MATCH grammar.
      const tokens = query.split(/\s+/).map((token) => token.replace(/"/g, "")).filter((token) => token.length > 0);
      if (tokens.length === 0) return [];
      let ids: string[];
      try {
        const result = local.runQueryAst({
          version: 2,
          scope: { type: "entire_workspace" },
          root: {
            type: "group",
            logic: "and",
            children: [
              {
                type: "member",
                family: "class",
                op: "in",
                target: {
                  mode: "ids",
                  ids: [SYSTEM_CLASS_UUIDS.source, ...Object.values(SOURCE_CLASS_IDS)],
                },
              },
              { type: "content", op: "fts", value: tokens.map((token) => `"${token}"`).join(" ") },
            ],
          },
        }) as { ids: string[] };
        ids = result.ids;
      } catch {
        return []; // an FTS-unparseable query answers empty, never a 500
      }
      const results: SearchResultItem[] = [];
      for (const id of ids.slice(0, limit)) {
        const object = local.getObject(id).object as {
          id: string;
          name: string | null;
          classIds: string[];
          properties?: Array<{ schemaId: string; value: unknown }>;
        };
        // The member query already guarantees source-family membership; a
        // node carrying ONLY the bare `source` class (no roster subclass)
        // surfaces as classKey "source" instead of being dropped.
        const classKey = sourceClassOf(object.classIds) ?? "source";
        const props = Array.isArray(object.properties) ? object.properties : [];
        const valuesOf = (schemaId: string): unknown[] =>
          props.filter((p) => p.schemaId === schemaId).map((p) => p.value);
        const stringsOf = (schemaId: string): string[] =>
          valuesOf(schemaId)
            .flatMap((v) => (Array.isArray(v) ? v : [v]))
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .map((v) => v.trim());

        const citekey = stringsOf(SYSTEM_PROPERTY_UUIDS.citekey)[0];
        const authors = stringsOf(SYSTEM_PROPERTY_UUIDS.authors);
        // year: a plain string publicationDate wins; a {nodeId} date ref
        // resolves through the node's current title (one extra read).
        let year: number | undefined;
        for (const value of valuesOf(SYSTEM_PROPERTY_UUIDS.publicationDate)) {
          const literal =
            typeof value === "string"
              ? value
              : typeof (value as { nodeId?: unknown } | null)?.nodeId === "string"
                ? resolveName(local, (value as { nodeId: string }).nodeId)
                : undefined;
          year = literal !== undefined ? yearFromDate(literal) : undefined;
          if (year !== undefined) break;
        }
        results.push({
          objectId: object.id,
          title: object.name ?? "",
          ...(citekey !== undefined ? { citekey } : {}),
          ...(authors.length > 0 ? { authors } : {}),
          ...(year !== undefined ? { year } : {}),
          classKey,
        });
      }
      return results;
    },
    close() {
      clearInterval(syncTimer);
      local.close();
      releaseServeLock(lockPath);
    },
  };
}

function resolveName(local: LocalWorkspace, id: string): string | undefined {
  try {
    const name = (local.getObject(id).object as { name?: string | null }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

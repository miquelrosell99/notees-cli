/**
 * Local CLI state at ~/.notees/state.json (workspace cursors per server).
 * Reads are tolerant (missing/corrupt file → empty state); writes are atomic
 * (tmp + rename). Tests inject a custom state path via NOTEES_STATE_FILE.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServerState {
  workspaceId?: string;
  cursorSeq?: number;
  updatedAt?: string;
}

export interface CliState {
  version: 1;
  servers: Record<string, ServerState>;
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NOTEES_STATE_FILE ?? join(homedir(), ".notees", "state.json");
}

export function loadState(path: string): CliState {
  if (!existsSync(path)) return { version: 1, servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CliState>;
    if (parsed.version !== 1 || typeof parsed.servers !== "object" || parsed.servers === null) {
      return { version: 1, servers: {} };
    }
    return { version: 1, servers: parsed.servers };
  } catch {
    return { version: 1, servers: {} };
  }
}

export function saveState(path: string, state: CliState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function serverState(path: string, server: string): ServerState {
  return loadState(path).servers[server] ?? {};
}

export function updateServerState(
  path: string,
  server: string,
  patch: (current: ServerState) => ServerState,
): CliState {
  const state = loadState(path);
  state.servers[server] = patch(state.servers[server] ?? {});
  saveState(path, state);
  return state;
}

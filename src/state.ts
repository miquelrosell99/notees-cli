/**
 * Local CLI state at ~/.notees/state.json (workspace cursors per server,
 * per-profile config defaults from `notees config set`).
 * Reads are tolerant (missing/corrupt file → empty state); writes are atomic
 * (tmp + rename). Tests inject a custom state path via NOTEES_STATE_FILE.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Stored credential from `notees auth login` (the state file is mode 0600). */
export interface StoredCredential {
  kind: "apiKey" | "session";
  token: string;
  /** The api-keys row id — `notees auth logout` revokes it server-side. */
  keyId?: string;
  email?: string;
  createdAt: string;
}

/**
 * Cached account master key for encrypted (E2EE) workspaces — the CLI-side
 * parity of the web client's persisted custody record (IndexedDB): one
 * password unlock must not be required on every invocation. Raw b64u bytes,
 * same trust domain as the stored credential (the state file is mode 0600).
 * Cleared by `notees auth lock` and `notees auth logout`.
 */
export interface CachedMasterKey {
  /** b64u of the 32-byte master key. */
  bytes: string;
  updatedAt: string;
}

export interface ServerState {
  workspaceId?: string;
  cursorSeq?: number;
  updatedAt?: string;
  /** Resolved --workspace name → workspace id (per server + profile). */
  workspaces?: Record<string, string>;
  /** Credential for this server+profile (set by `notees auth login`). */
  credential?: StoredCredential;
  /** Cached master key (encrypted workspaces; written on first unlock). */
  masterKey?: CachedMasterKey;
}

/**
 * Per-profile defaults written by `notees config set` — the stored default
 * server (so bare `notees <cmd>` works without env vars) and the stored
 * default workspace. Keyed by profile name, NOT by `profile:server`: the
 * server is what is being selected here, so it cannot be part of the key.
 */
export interface ProfileDefaults {
  server?: string;
  workspace?: string;
  updatedAt?: string;
}

export interface CliState {
  version: 1;
  servers: Record<string, ServerState>;
  /** Absent in state files written before `notees config` existed. */
  profiles?: Record<string, ProfileDefaults>;
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
    // Tolerant of state files written before profiles existed (and of any
    // other unknown top-level fields, which are dropped on save).
    const profiles =
      typeof parsed.profiles === "object" && parsed.profiles !== null ? parsed.profiles : undefined;
    return { version: 1, servers: parsed.servers, ...(profiles !== undefined ? { profiles } : {}) };
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

/** The cached master key for this server+profile, or undefined (never cached / cleared). */
export function cachedMasterKey(path: string, server: string): CachedMasterKey | undefined {
  return loadState(path).servers[server]?.masterKey;
}

/** Cache the master key bytes (atomic, mode 0600). */
export function storeCachedMasterKey(path: string, server: string, bytes: string): void {
  updateServerState(path, server, (current) => ({
    ...current,
    masterKey: { bytes, updatedAt: new Date().toISOString() },
  }));
}

/** Drop the cached master key (`notees auth lock` / logout). */
export function clearCachedMasterKey(path: string, server: string): boolean {
  const had = cachedMasterKey(path, server) !== undefined;
  if (had) {
    updateServerState(path, server, (current) => {
      const next = { ...current };
      delete next.masterKey;
      return next;
    });
  }
  return had;
}

export function profileDefaults(path: string, profile: string): ProfileDefaults {
  return loadState(path).profiles?.[profile] ?? {};
}

/** Atomic read-modify-write of one profile's defaults (same discipline as updateServerState). */
export function updateProfileDefaults(
  path: string,
  profile: string,
  patch: (current: ProfileDefaults) => ProfileDefaults,
): CliState {
  const state = loadState(path);
  state.profiles = state.profiles ?? {};
  state.profiles[profile] = patch(state.profiles[profile] ?? {});
  saveState(path, state);
  return state;
}

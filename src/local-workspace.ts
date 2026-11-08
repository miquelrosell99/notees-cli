/**
 * The local-first workspace session: the CLI's content surface since the
 * server retired its object/content API (plan 07). One derived SQLite store
 * per workspace lives under the CLI data dir (`<state-dir>/stores/`), the
 * vendored @notees/sync SyncEngine (HLC + seq cursor, snapshot shortcut,
 * durable local op log) keeps it converged with the relay, and EVERY content
 * read compiles/runs locally — objects, children, backlinks, search/FTS,
 * the query language (@notees/query over the local store). Writes author
 * envelopes (protocol v3), apply locally through the store appliers, and
 * push through the engine's outbox; acknowledged envelopes clear the durable
 * log, so an interrupted run never loses a write.
 *
 * Keyed (E2EE) workspaces: the workspace key is user custody. With a user
 * credential (session token or user API key) the wrapped key is fetched; the
 * envelope crypto then resolves from the CACHED master key (state file, the
 * web client's persisted-custody parity — no password needed) or, on first
 * use, from NOTEES_EMAIL + NOTEES_PASSWORD (/auth/unlock re-derives the KDF
 * record; the master key unwraps locally and its bytes are cached for later
 * invocations). An operator credential can never read a workspace key (403
 * by design) and a keyed workspace is refused loudly; a keyless-workspace
 * detection rides the relay's snapshot meta (`sealed`) plus the key
 * endpoint's 404.
 *
 * The read projections below are the retired server content reads
 * (routes-objects.ts, plan-07 commit) ported to run over the local derived
 * store — response shapes are byte-compatible with what the REST API
 * returned, so the command layer and `--json` contract are unchanged.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  SYSTEM_PROPERTY_UUIDS,
  buildSystemSeedEnvelopes,
  deriveDisplayName,
  fullTitleOf,
} from "@notees/domain";
import {
  Clock,
  b64uDecode,
  b64uEncode,
  compareHlc,
  deriveMachineKey,
  importMasterKey,
  importWorkspaceKey,
  maxHlc,
  newEnvelope,
  unwrapMasterKeyWithBytes,
  unwrapWorkspaceKey,
  type ContentAst,
  type Envelope,
  type Hlc,
  type KdfRecord,
} from "@notees/protocol";
import { parseQueryAst, runAggregate, runQuery } from "@notees/query";
import {
  MergeGuardError,
  Store,
  planMerge,
  visiblePropertyValueRows,
  type NodeRow,
  type SqliteDB,
  type StoreBackend,
} from "@notees/store";
import { betterSqlite3Backend } from "@notees/store/better-sqlite3";
import { HttpTransport, SyncEngine, SyncMeta, TransportError, keyCryptoProvider } from "@notees/sync";

import { CliError, EXIT } from "./exit-codes.js";
import { cachedMasterKey, storeCachedMasterKey } from "./state.js";
import { deriveUuid, uuidv7 } from "./uuid.js";

/** The device identity stamped on CLI-authored envelopes. */
const CLI_DEVICE_ID = "notees-cli";
/** The wire `client` claim for CLI-authored envelopes (shape-stable). */
const CLI_CLIENT = "cli";

export interface LocalWorkspaceOptions {
  server: string;
  apiKey: string;
  /** The resolved workspace uuid (x-workspace-id on every relay call). */
  workspaceId: string;
  /** Directory holding the per-workspace derived stores. */
  storeDir: string;
  fetchImpl?: typeof fetch;
  /** Sync-progress sink (the `notees sync` human output). */
  onSyncPhase?: (phase: string, message: string) => void;
  /**
   * CLI state seams for the master-key cache (keyed workspaces): when both
   * are given, a successful password unlock persists the master key and
   * later invocations resolve the envelope crypto from the cache alone.
   */
  statePath?: string;
  stateKey?: string;
  /**
   * `notees serve`: a failed bootstrap sync with an EXISTING store file
   * serves the last synced projection (offline-first) instead of dying.
   * A missing store still fails loud — there is nothing to serve.
   */
  bestEffortSync?: boolean;
  /** Warning sink for the best-effort path (and future advisory notes). */
  onWarning?: (message: string) => void;
}

interface ApiObject {
  id: string;
  workspaceId: string;
  isClass: boolean;
  isEmbedded: boolean;
  parentId: string | null;
  classIds: string[];
  tagIds: string[];
  name: string | null;
  icon: string | null;
  color: string | null;
  coverAssetId: string | null;
  bannerAssetId: string | null;
  aliasedNodeId: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  hlc: { physical: number; logical: number };
}

export interface ListObjectsQuery {
  isClass?: boolean;
  isEmbedded?: boolean;
  class?: string;
  parent?: string;
  trashed?: boolean;
  q?: string;
  property?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchObjectsQuery {
  q: string;
  isClass?: boolean;
  isEmbedded?: boolean;
  limit?: number;
  cursor?: string | null;
}

/** True when the ref is already a workspace id (uuid) — no resolution. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contentAstOf(row: Pick<NodeRow, "content">): ContentAst {
  return (row.content === null ? [] : (JSON.parse(row.content) as ContentAst)) as ContentAst;
}

/**
 * A file backend for the CLI's short-lived sessions: the stock better-sqlite3
 * backend restores a snapshot onto a TEMP file (right for the browser's
 * disposable worker stores, wrong for a CLI whose whole session is one
 * invocation — the durable store file would never advance, every command
 * would re-restore, and the durable local op log would live on the discarded
 * temp image). This backend writes the serialized image into the REAL file
 * instead, so the store on disk always carries the restored state and the
 * engine's watermark persists where the next invocation reads it.
 */
function durableFileBackend(path: string): StoreBackend {
  const base = betterSqlite3Backend(path);
  return {
    ftsModule: base.ftsModule,
    open: () => base.open(),
    restore(bytes: Uint8Array): SqliteDB {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(path + suffix, { force: true });
      }
      writeFileSync(path, bytes);
      return base.open();
    },
    reset: () => base.reset(),
  };
}

/**
 * Open the local-first session for a workspace: custody probe (keyed vs
 * keyless), derived store open, engine bootstrap (replay the durable
 * unpushed backlog, sync push+pull, client-side seed of an empty keyed
 * store), and return the session. Every content command starts here; the
 * sync means reads are fresh and writes ride the outbox.
 */
export async function openLocalWorkspace(options: LocalWorkspaceOptions): Promise<LocalWorkspace> {
  const base = options.server.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  mkdirSync(options.storeDir, { recursive: true });
  const storePath = join(options.storeDir, `${options.workspaceId}.db`);

  const custody = await probeCustody(base, options.apiKey, options.workspaceId, fetchImpl);
  let crypto: ReturnType<typeof keyCryptoProvider> | undefined;
  let keySource: KeySource = null;
  if (custody.keyed) {
    if (custody.wrappedKey === undefined) {
      throw new CliError(
        EXIT.auth,
        `workspace ${options.workspaceId} is encrypted and this credential cannot read its key ` +
          "(workspace keys are user custody — sign in with `notees auth login` so the CLI holds a user credential)",
      );
    }
    const resolved = await resolveKeyedCrypto({
      base,
      apiKey: options.apiKey,
      workspaceId: options.workspaceId,
      wrappedKey: custody.wrappedKey,
      fetchImpl,
      ...(options.statePath !== undefined && options.stateKey !== undefined
        ? { statePath: options.statePath, stateKey: options.stateKey }
        : {}),
    });
    crypto = resolved.provider;
    keySource = resolved.source;
  }

  // Store.open (better-sqlite3) creates the store file EAGERLY — capture
  // existence BEFORE the open, else the best-effort check below is vacuous
  // (a first run against an unreachable server would "serve" a store that
  // did not exist until this very call).
  const hadStore = existsSync(storePath);
  const store = Store.open(durableFileBackend(storePath));
  const transport = new HttpTransport({
    baseUrl: base,
    apiKey: options.apiKey,
    workspaceId: options.workspaceId,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  const clock = new Clock(CLI_DEVICE_ID);
  const session = new LocalWorkspace(options, store, transport, clock, crypto);
  session.keySource = keySource;
  try {
    await session.bootstrap();
  } catch (error) {
    if (options.bestEffortSync === true && hadStore) {
      options.onWarning?.(
        `initial sync failed — serving the last synced store (${error instanceof Error ? error.message : String(error)})`,
      );
    } else {
      store.close();
      throw mapSyncError(error, base);
    }
  }
  return session;
}

/** How the envelope crypto for a keyed workspace was resolved (surfaced by `notees auth unlock`). */
export type KeySource = "cache" | "machine" | "password" | null;

export interface ResolveKeyedCryptoOptions {
  base: string;
  apiKey: string;
  workspaceId: string;
  wrappedKey: string;
  fetchImpl: typeof fetch;
  /** Both seams enable the master-key cache (state file, mode 0600). */
  statePath?: string;
  stateKey?: string;
}

/**
 * Resolve the envelope crypto for a keyed workspace. The CACHED master key
 * is tried first — a hit needs neither the password nor an /auth/unlock
 * round-trip; then MACHINE-KEY custody (a key minted with custody unwraps
 * the master key from its own token — no password, nothing cached); on miss
 * the password path re-derives the master key (/auth/unlock answers the KDF
 * record, the unwrap runs locally) and caches the raw bytes for later
 * invocations — the web client's persisted-custody parity (IndexedDB there,
 * the CLI state file here). A stale cache (rotated password, replaced key)
 * fails the unwrap locally and falls through, same as a failed machine
 * unwrap, to the password path, which overwrites the cache on success.
 */
export async function resolveKeyedCrypto(
  options: ResolveKeyedCryptoOptions,
): Promise<{ provider: ReturnType<typeof keyCryptoProvider>; source: Exclude<KeySource, null> }> {
  if (options.statePath !== undefined && options.stateKey !== undefined) {
    const fromCache = await unlockFromCache(options.statePath, options.stateKey, options.wrappedKey);
    if (fromCache !== undefined) return { provider: fromCache, source: "cache" };
  }

  // Machine-key custody: a key minted with custody opens the workspace with
  // no password (the token itself unwraps the master key) — tried before the
  // password path; a human key (404) or any failure falls through.
  const fromMachine = await unlockFromMachineKey(options.base, options.apiKey, options.wrappedKey, options.fetchImpl);
  if (fromMachine !== undefined) return { provider: fromMachine, source: "machine" };

  const email = process.env.NOTEES_EMAIL;
  const password = process.env.NOTEES_PASSWORD;
  if (email === undefined || email.length === 0 || password === undefined || password.length === 0) {
    throw new CliError(
      EXIT.auth,
      `workspace ${options.workspaceId} is encrypted — set NOTEES_EMAIL and NOTEES_PASSWORD so the CLI can ` +
        "re-derive the master key and unwrap the workspace key " +
        "(or unlock once with `notees auth unlock` to cache the master key; `notees auth lock` clears it)",
    );
  }
  const kdfRecord = await fetchKdfRecord(options.base, options.apiKey, options.fetchImpl);
  const { key, bytes } = await unwrapMasterKeyWithBytes(password, kdfRecord);
  const provider = await workspaceCryptoFromMaster(key, options.wrappedKey);
  if (options.statePath !== undefined && options.stateKey !== undefined) {
    try {
      storeCachedMasterKey(options.statePath, options.stateKey, b64uEncode(bytes));
    } catch {
      // Cache write is best-effort, same as the web client's custody store.
    }
  }
  return { provider, source: "password" };
}

/** Cache hit → the envelope crypto, or undefined (no cache / stale bytes). */
async function unlockFromCache(
  statePath: string,
  stateKey: string,
  wrappedKey: string,
): Promise<ReturnType<typeof keyCryptoProvider> | undefined> {
  const cached = cachedMasterKey(statePath, stateKey);
  if (cached === undefined) return undefined;
  try {
    const masterKey = await importMasterKey(b64uDecode(cached.bytes));
    return await workspaceCryptoFromMaster(masterKey, wrappedKey);
  } catch {
    return undefined;
  }
}

/**
 * Machine-key custody (`GET /api-keys/self/custody`, the key authenticates
 * itself): the token derives the key that unwraps the stored master key,
 * which unwraps the workspace key — the key alone opens the workspace, no
 * password and nothing cached on disk. A human key (404) or any fetch/unwrap
 * failure returns undefined (the password path is the fallback).
 */
async function unlockFromMachineKey(
  base: string,
  apiKey: string,
  wrappedKey: string,
  fetchImpl: typeof fetch,
): Promise<ReturnType<typeof keyCryptoProvider> | undefined> {
  try {
    const response = await fetchImpl(`${base}/api/api-keys/self/custody`, {
      headers: { "x-api-key": apiKey },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { salt: string; wrappedMaster: string };
    const machineKey = await importMasterKey(deriveMachineKey(apiKey, b64uDecode(body.salt)));
    const unwrapped = await unwrapWorkspaceKey(machineKey, body.wrappedMaster);
    // unwrapWorkspaceKey imports its result with workspace-key usages
    // (encrypt/decrypt); the master must ALSO unwrap — re-import the raw
    // bytes with the master usages (the recovery path never needs this: it
    // only re-WRAPS the master).
    const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", unwrapped as never));
    const masterKey = await importMasterKey(raw);
    return await workspaceCryptoFromMaster(masterKey, wrappedKey);
  } catch {
    return undefined;
  }
}

/** Unwrap the workspace key with the master key and build the envelope crypto provider. */
async function workspaceCryptoFromMaster(
  masterKey: Parameters<typeof unwrapWorkspaceKey>[0],
  wrappedKey: string,
): Promise<ReturnType<typeof keyCryptoProvider>> {
  const workspaceKey = await unwrapWorkspaceKey(masterKey, wrappedKey);
  // CryptoKey stays opaque (skipLibCheck resolves the protocol's webcrypto
  // types) — export to raw bytes for importWorkspaceKey inline.
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", workspaceKey as never));
  return keyCryptoProvider(await importWorkspaceKey(raw));
}

/**
 * Sync/bootstrap failures map onto the CLI exit-code contract: an HTTP
 * TransportError answers with its status (401/403 → auth, else domain), a
 * fetch-level failure (DNS/refused/abort/TLS — never a wire answer) is the
 * network code.
 */
function mapSyncError(error: unknown, server: string): CliError {
  if (error instanceof TransportError) {
    const exitCode = error.status === 401 || error.status === 403 ? EXIT.auth : EXIT.domain;
    return new CliError(exitCode, `sync failed: ${error.message}`, { status: error.status, code: error.code });
  }
  if (error instanceof CliError) return error;
  // A fetch-level failure (DNS/refused/abort/TLS — never a wire answer) is a
  // TypeError from fetch; anything else that escaped the pull is an apply
  // failure against the log (domain — the server answered, the envelope did
  // not apply).
  if (error instanceof TypeError) {
    const reason = error.cause instanceof Error ? error.cause.message : error.message;
    return new CliError(EXIT.network, `cannot reach server at ${server} (${reason})`);
  }
  return new CliError(EXIT.domain, `sync failed: ${error instanceof Error ? error.message : String(error)}`);
}

interface CustodyProbe {
  keyed: boolean;
  wrappedKey?: string;
}

/**
 * Keyed-vs-keyless detection, plus the wrapped key when this credential may
 * read it. A user credential answers the key endpoint 200 (wrapped key
 * present) or 404 ("no workspace key stored" = keyless); an operator
 * credential gets 403 by design — the relay snapshot meta's `sealed` flag is
 * the fallback signal (a sealed checkpoint only exists when a keyed client
 * produced it). The KDF record is NOT fetched here: it only exists for the
 * password path (an /auth/unlock round-trip wasted on every cache hit).
 */
async function probeCustody(
  base: string,
  apiKey: string,
  workspaceId: string,
  fetchImpl: typeof fetch,
): Promise<CustodyProbe> {
  const headers = { "x-api-key": apiKey };
  const keyResponse = await fetchImpl(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/key`, {
    headers,
  }).catch(() => null);
  if (keyResponse !== null && keyResponse.ok) {
    const body = (await keyResponse.json()) as { wrappedKey: string };
    return { keyed: true, wrappedKey: body.wrappedKey };
  }
  if (keyResponse !== null && keyResponse.status === 403) {
    // Operator (or anonymous) principal: keys are user custody. A sealed
    // snapshot is the honest keyed signal available to this credential.
    const statsResponse = await fetchImpl(
      `${base}/api/relay/v2/snapshot?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers },
    ).catch(() => null);
    const sealed =
      statsResponse !== null && statsResponse.ok
        ? ((await statsResponse.json()) as { sealed?: boolean }).sealed === true
        : false;
    return { keyed: sealed };
  }
  // 404 ("no workspace key stored") or an unreachable server treated as
  // keyless here — the engine's own sync reports the network truth loudly.
  return { keyed: false };
}

/** /auth/unlock re-derives the kdf record for the account password. */
async function fetchKdfRecord(base: string, apiKey: string, fetchImpl: typeof fetch): Promise<KdfRecord> {
  const email = process.env.NOTEES_EMAIL;
  const password = process.env.NOTEES_PASSWORD;
  if (email === undefined || email.length === 0 || password === undefined || password.length === 0) {
    // The caller's fail-loud message names the env pair; this guard only
    // keeps the probe total (kdfRecord undefined → the open path refuses).
    return undefined as unknown as KdfRecord;
  }
  const response = await fetchImpl(`${base}/api/auth/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new CliError(
      response.status === 401 || response.status === 403 ? EXIT.auth : EXIT.domain,
      `cannot re-derive the master key (/auth/unlock answered HTTP ${response.status}) — check NOTEES_EMAIL / NOTEES_PASSWORD`,
    );
  }
  const body = (await response.json()) as { kdf: KdfRecord };
  return body.kdf;
}

export class LocalWorkspace {
  /** Set when a best-effort push failed — callers surface it on stderr. */
  pushWarning: string | null = null;
  /**
   * How the envelope crypto was resolved for a keyed workspace ("cache" =
   * the cached master key answered, "password" = NOTEES_EMAIL/PASSWORD
   * re-derived it); null on a keyless workspace. `notees auth unlock`
   * reports it so the operator sees whether the cache engaged.
   */
  keySource: KeySource = null;
  private cursorSeq = 0;
  private restoreEpoch = 0;

  constructor(
    readonly options: LocalWorkspaceOptions,
    readonly store: Store,
    private readonly transport: HttpTransport,
    private readonly clock: Clock,
    private readonly crypto: ReturnType<typeof keyCryptoProvider> | undefined,
  ) {}

  /** Engine bootstrap + one sync cycle (mirrors the web client's bootstrap). */
  async bootstrap(): Promise<void> {
    const engine = this.engine;
    // Durable unpushed backlog (offline work from a previous run): apply is
    // idempotent by envelope id, so already-applied ops no-op and the rest
    // re-enter the outbox for this run's push.
    for (const env of this.store.unpushedEnvelopes()) {
      if ((env as Envelope).workspaceId === this.options.workspaceId) {
        engine.enqueue(env as Envelope);
      }
    }
    await engine.sync();
    // Keyless fresh workspace: the server's seed shim fires lazily, triggered
    // by a coordination read (plan 07 kept GET /api/classes for exactly this
    // legacy-CLI contract) — a read-first CLI command must not see an empty
    // workspace. Keyed workspaces are the opposite: client-seeded below.
    if (this.crypto === undefined && this.storeIsEmpty()) {
      const base = this.options.server.replace(/\/+$/, "");
      const response = await (this.options.fetchImpl ?? fetch)(`${base}/api/classes`, {
        headers: { "x-api-key": this.options.apiKey },
      }).catch(() => null);
      if (response !== null && response.ok) await engine.pull();
    }
    // Client-side seeding of an EMPTY KEYED workspace (the server shim
    // seeds keyless ones): fixed system-class UUIDs converge across devices.
    if (this.crypto !== undefined && this.storeIsEmpty()) {
      const stamp = (
        opType: string,
        payload: Record<string, unknown>,
        affected?: string[],
      ): Envelope =>
        newEnvelope({
          workspaceId: this.options.workspaceId,
          actorId: this.actorId(),
          deviceId: CLI_DEVICE_ID,
          client: "seed",
          hlc: this.clock.now(),
          affectedNodeIds: affected ?? [],
          opType,
          payload,
          timestamp: new Date().toISOString(),
        });
      for (const envelope of buildSystemSeedEnvelopes(stamp)) {
        engine.enqueue(envelope);
      }
      await engine.push();
    }
    const persisted = this.store.database
      .prepare("SELECT value FROM app_meta WHERE key = ?")
      .get(`sync:${this.options.workspaceId}:state`) as { value: string } | undefined;
    if (persisted !== undefined) {
      const parsed = JSON.parse(persisted.value) as { cursorSeq?: number; restoreEpoch?: number };
      this.cursorSeq = parsed.cursorSeq ?? 0;
      this.restoreEpoch = parsed.restoreEpoch ?? 0;
    }
  }

  private engine_: SyncEngine | null = null;
  private get engine(): SyncEngine {
    if (this.engine_ === null) {
      this.engine_ = new SyncEngine(this.store, this.transport, this.clock, {
        workspaceId: this.options.workspaceId,
        ...(this.crypto !== undefined ? { crypto: this.crypto } : {}),
        callbacks: {
          onSyncPhase: (phase, message) => this.options.onSyncPhase?.(phase, message),
          // Durable local op log: locally-authored envelopes survive the
          // process exit; acknowledged ones clear.
          onEnqueued: (envelope) => this.store.recordLocalEnvelope(envelope),
          onAcknowledged: (ids) => {
            this.store.markLocalEnvelopesPushed(ids);
            this.store.prunePushedLocalEnvelopes();
          },
          onError: (error) => {
            this.pushWarning = error.message;
          },
        },
      });
    }
    return this.engine_;
  }

  /** Stable per-credential actor attribution (envelope actorId — a uuid). */
  private actorId(): string {
    return deriveUuid(`notees:actor:cli:${this.options.apiKey}:${this.options.workspaceId}`);
  }

  private storeIsEmpty(): boolean {
    const row = this.store.database.prepare("SELECT COUNT(*) AS n FROM node").get() as { n: number };
    return row.n === 0;
  }

  // --- sync ----------------------------------------------------------------

  /** Pull remote changes now (after a coordination write that bypassed the
   * outbox — the surviving server-side property-schema/binding routes — so
   * the local store observes it within the same session). */
  async refresh(): Promise<void> {
    await this.engine.pull();
  }

  /** One manual sync cycle (push the outbox, then pull). */
  async sync(): Promise<void> {
    await this.engine.sync();
    this.pushWarning = null;
    await this.engine.push().catch((error: Error) => {
      this.pushWarning = error.message;
    });
  }

  /** Push pending outbox ops (write commands call this before exiting). */
  async push(): Promise<void> {
    try {
      await this.engine.push();
    } catch (error) {
      // The write is durable in the local op log — surface, don't lose.
      this.pushWarning = error instanceof Error ? error.message : String(error);
    }
  }

  async serverStats(): Promise<{ envelopeCount: number; restoreEpoch: number }> {
    const response = await (this.options.fetchImpl ?? fetch)(
      `${this.options.server.replace(/\/+$/, "")}/api/relay/v2/stats?workspaceId=${encodeURIComponent(this.options.workspaceId)}`,
      { headers: { "x-api-key": this.options.apiKey } },
    );
    if (!response.ok) {
      throw new CliError(EXIT.domain, `relay stats answered HTTP ${response.status}`);
    }
    const body = (await response.json()) as { envelopeCount: number; restoreEpoch: number };
    return body;
  }

  localCursor(): { cursorSeq: number; restoreEpoch: number } {
    return { cursorSeq: this.cursorSeq, restoreEpoch: this.restoreEpoch };
  }

  unpushedCount(): number {
    const row = this.store.database
      .prepare("SELECT COUNT(*) AS n FROM local_op_log WHERE pushed_at IS NULL")
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.store.close();
  }

  // --- write seam -----------------------------------------------------------

  /** Stamp one envelope (protocol v3, notees-cli attribution). NOT applied. */
  makeEnvelope(opType: string, payload: Record<string, unknown>, affectedNodeIds: string[]): Envelope {
    return newEnvelope({
      workspaceId: this.options.workspaceId,
      actorId: this.actorId(),
      deviceId: CLI_DEVICE_ID,
      client: CLI_CLIENT,
      hlc: this.clock.now(),
      affectedNodeIds,
      opType,
      payload,
    });
  }

  /** Apply + enqueue a prebuilt envelope (the shell's submitOps seam). */
  async submitEnvelope(envelope: Envelope, options: { push?: boolean | undefined } = {}): Promise<void> {
    this.engine.enqueue(envelope);
    if (options.push !== false) await this.push();
  }

  /**
   * The single content-write seam: validate-stamp the envelope (protocol
   * v3), apply it through the store appliers (fail-loud — an impossible or
   * invalid op throws BEFORE anything enters the outbox, mirroring the
   * retired server's loud 422s), enqueue it for push, and push now so a
   * successful exit means the server has it.
   */
  async submit(
    opType: string,
    payload: Record<string, unknown>,
    affectedNodeIds: string[],
    options: { push?: boolean | undefined } = {},
  ): Promise<Envelope> {
    const envelope = this.makeEnvelope(opType, payload, affectedNodeIds);
    this.engine.enqueue(envelope);
    if (options.push !== false) await this.push();
    return envelope;
  }

  // --- read projections (the retired server content API, ported local) ------

  getObject(id: string): { object: Record<string, unknown> } {
    const row = this.requireNode(id);
    return { object: this.fullObject(row) };
  }

  getChildren(id: string): { children: Record<string, unknown>[] } {
    this.requireNode(id);
    const children = this.store
      .children(id)
      .filter((row) => row.is_active === 1)
      .map((row) => this.fullObject(row));
    return { children };
  }

  listObjects(query: ListObjectsQuery): { objects: ApiObject[]; nextCursor: string | null } {
    const limit = query.limit ?? 100;
    const clauses = [
      query.trashed === true ? "n.is_active = 0" : "n.is_active = 1",
      "n.workspace_id = ?",
    ];
    const params: unknown[] = [this.options.workspaceId];
    if (query.parent !== undefined) {
      clauses.push("n.parent_id = ?");
      params.push(query.parent);
    }
    if (query.isClass !== undefined) {
      clauses.push("n.is_class = ?");
      params.push(query.isClass ? 1 : 0);
    }
    if (query.isEmbedded !== undefined) {
      clauses.push(
        query.isEmbedded
          ? "n.is_class = 0 AND n.parent_id IS NOT NULL AND n.is_embedded = 1"
          : "n.is_class = 0 AND (n.parent_id IS NULL OR n.is_embedded = 0)",
      );
    }
    if (query.class !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM class_member_set cm WHERE cm.node_id = n.id AND cm.class_id = ? AND cm.present = 1)",
      );
      params.push(query.class);
    }
    if (query.property !== undefined) {
      const colon = query.property.indexOf(":");
      const schemaId = query.property.slice(0, colon);
      const rawValue = query.property.slice(colon + 1);
      if (!UUID_PATTERN.test(schemaId)) {
        throw new CliError(EXIT.domain, "property filter schema id must be a UUID");
      }
      clauses.push(
        "EXISTS (SELECT 1 FROM property_value pv WHERE pv.node_id = n.id AND pv.property_schema_id = ? AND pv.value = ?)",
      );
      params.push(schemaId, JSON.stringify(rawValue));
    }
    if (query.q !== undefined) {
      const hits = this.store.search(query.q, 10_000);
      if (hits.length === 0) return { objects: [], nextCursor: null };
      clauses.push(`n.id IN (${hits.map(() => "?").join(",")})`);
      params.push(...hits.map((hit) => hit.nodeId));
    }
    if (query.cursor !== undefined && query.cursor.length > 0) {
      clauses.push("n.id > ?");
      params.push(query.cursor);
    }
    const rows = this.store.database
      .prepare(`SELECT n.* FROM node n WHERE ${clauses.join(" AND ")} ORDER BY n.id ASC LIMIT ?`)
      .all(...params, limit + 1) as unknown as NodeRow[];
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;
    return { objects: page.map((row) => this.nodeToApi(row)), nextCursor };
  }

  searchObjects(query: SearchObjectsQuery): { results: unknown[]; nextCursor: string | null } {
    const page = this.store.searchPage(query.q, {
      limit: query.limit ?? 50,
      cursor: query.cursor ?? null,
    });
    const results = page.hits
      .map((hit) => this.store.getNode(hit.nodeId))
      .filter((row): row is NodeRow => row !== undefined && row.is_active === 1)
      .filter((row) => query.isClass === undefined || (row.is_class === 1) === query.isClass)
      .filter((row) => query.isEmbedded === undefined || (row.is_embedded === 1) === query.isEmbedded)
      .map((row) => {
        const api = this.nodeToApi(row);
        return {
          id: api.id,
          isClass: api.isClass,
          isEmbedded: api.isEmbedded,
          name: api.name,
          parentId: api.parentId,
          updatedAt: api.updatedAt,
        };
      });
    return { results, nextCursor: page.nextCursor };
  }

  /** The query language over the local store (compile + execute, no server). */
  runQueryAst(ast: unknown): unknown {
    let parsed;
    try {
      parsed = parseQueryAst(ast);
    } catch (error) {
      throw new CliError(EXIT.domain, `invalid query AST: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (parsed.aggregation !== undefined) {
        return runAggregate(this.store, parsed);
      }
      const { ids, rows } = runQuery(this.store, parsed);
      return {
        ids,
        rows: rows.map((row) => {
          const derived =
            fullTitleOf({
              id: String(row.id),
              isClass: row.is_class as number,
              isEmbedded: row.is_embedded as number,
              contentAst: JSON.parse((row.content as string | null) ?? "[]") as ContentAst,
              classIds: JSON.parse((row.class_ids as string | null) ?? "[]") as string[],
            }) || null;
          const summary: Record<string, unknown> = {
            id: String(row.id),
            isClass: (row.is_class as number) === 1,
            isEmbedded: (row.is_embedded as number) === 1,
            name: derived,
            parentId: (row.parent_id as string | null) ?? null,
            createdAt: (row.created_at as string | null) ?? null,
            updatedAt: (row.updated_at as string | null) ?? null,
          };
          if (row.distance !== undefined) summary.distance = row.distance;
          return summary;
        }),
      };
    } catch (error) {
      throw new CliError(
        EXIT.domain,
        `query not supported: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  backlinks(id: string): { nodeId: string; backlinks: unknown[] } {
    this.requireNode(id);
    return { nodeId: id, backlinks: this.store.backlinks(id) };
  }

  effectiveProperties(id: string): { nodeId: string; properties: unknown[] } {
    // No existence gate: the retired route answered [] for an unknown id
    // (getEffectiveProperties over a missing node has no rows) and the
    // workflow planner's convergence checks rely on that leniency.
    const properties = this.store.getEffectiveProperties(id).map((row) => ({
      schemaId: row.propertySchemaId,
      schemaName: row.schema?.name ?? null,
      schemaType: row.schema?.type ?? null,
      elementId: row.elementId,
      idx: row.idx,
      value: row.value,
      metadata: row.metadata,
      source: row.source,
      boundBy: row.boundBy,
      hideWhenEmpty: row.hideWhenEmpty,
    }));
    return { nodeId: id, properties };
  }

  listClasses(): { classes: unknown[] } {
    const classes = this.store.database
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color, c.description,
                n.content AS nodeContent, n.class_ids AS nodeClassIds,
                (SELECT json_group_array(parent_class_id) FROM (
                   SELECT parent_class_id FROM class_extends e
                   WHERE e.class_id = c.id ORDER BY parent_class_id)) AS parentClassIds,
                (SELECT COUNT(*) FROM class_member_set m WHERE m.class_id = c.id AND m.present = 1) AS memberCount
         FROM class c LEFT JOIN node n ON n.id = c.id AND n.is_active = 1
         WHERE c.active = 1`,
      )
      .all() as Array<{
      id: string;
      name: string;
      icon: string | null;
      color: string | null;
      description: string | null;
      nodeContent: string | null;
      nodeClassIds: string | null;
      parentClassIds: string | null;
      memberCount: number;
    }>;
    const listed = classes.map((row) => ({
      id: row.id,
      name: classNameFromNode(row.nodeContent, row.nodeClassIds, row.name),
      icon: row.icon,
      color: row.color,
      description: row.description,
      parentClassIds: JSON.parse(row.parentClassIds ?? "[]") as string[],
      memberCount: row.memberCount,
    }));
    listed.sort(
      (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
    );
    return { classes: listed };
  }

  getClass(id: string): { class: Record<string, unknown>; members: unknown[] } {
    const classRow = this.store.database
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color, c.description,
                n.content AS nodeContent, n.class_ids AS nodeClassIds,
                (SELECT json_group_array(parent_class_id) FROM (
                   SELECT parent_class_id FROM class_extends e
                   WHERE e.class_id = c.id ORDER BY parent_class_id)) AS parentClassIds
         FROM class c LEFT JOIN node n ON n.id = c.id AND n.is_active = 1
         WHERE c.id = ? AND c.active = 1`,
      )
      .get(id) as
      | {
          id: string;
          name: string;
          icon: string | null;
          color: string | null;
          description: string | null;
          nodeContent: string | null;
          nodeClassIds: string | null;
          parentClassIds: string | null;
        }
      | undefined;
    if (classRow === undefined) {
      throw new CliError(EXIT.domain, `class ${id} does not exist`);
    }
    const members = (
      this.store.database
        .prepare(
          `SELECT n.id, n.is_class AS isClass, n.is_embedded AS isEmbedded, n.content, n.class_ids
           FROM class_member_set m JOIN node n ON n.id = m.node_id
           WHERE m.class_id = ? AND m.present = 1 AND n.is_active = 1 ORDER BY n.id`,
        )
        .all(id) as Array<{ id: string; isClass: number; isEmbedded: number; content: string; class_ids: string }>
    ).map((row) => ({
      id: row.id,
      name:
        fullTitleOf({
          id: row.id,
          isClass: row.isClass,
          isEmbedded: row.isEmbedded,
          contentAst: JSON.parse(row.content) as ContentAst,
          classIds: JSON.parse(row.class_ids) as string[],
        }) || null,
      isClass: row.isClass === 1,
      isEmbedded: row.isEmbedded === 1,
    }));
    return {
      class: {
        id: classRow.id,
        name: classNameFromNode(classRow.nodeContent, classRow.nodeClassIds, classRow.name),
        icon: classRow.icon,
        color: classRow.color,
        description: classRow.description,
        parentClassIds: JSON.parse(classRow.parentClassIds ?? "[]") as string[],
      },
      members,
    };
  }

  propertyValues(id: string): { propertySchemaId: string; values: unknown[] } {
    const nameById = new Map(
      (
        this.store.database.prepare("SELECT id, name FROM node").all() as Array<{
          id: string;
          name: string | null;
        }>
      ).map((row) => [row.id, row.name]),
    );
    const values = visiblePropertyValueRows(this.store.database)
      .filter((row) => row.property_schema_id === id)
      .sort(
        (a, b) =>
          a.node_id.localeCompare(b.node_id) ||
          a.idx - b.idx ||
          (a.id < b.id ? -1 : 1),
      )
      .map((row) => ({
        objectId: row.node_id,
        objectName: nameById.get(row.node_id) ?? null,
        elementId: row.id,
        idx: row.idx,
        value: JSON.parse(row.value) as unknown,
      }));
    return { propertySchemaId: id, values };
  }

  /** Local name→id resolution (the retired GET /resolve?name= branch). */
  resolveName(name: string): { name: string | null; id: string; isClass: boolean; isEmbedded: boolean; parentId: string | null } {
    const wanted = name.toLowerCase();
    for (const hit of this.store.search(name, 100)) {
      const row = this.store.getNode(hit.nodeId);
      if (row === undefined || row.is_active !== 1) continue;
      const api = this.nodeToApi(row);
      const aliases = this.store.scalarPropertyValues(hit.nodeId, SYSTEM_PROPERTY_UUIDS.alias);
      const matchesName = (api.name ?? "").toLowerCase() === wanted;
      const matchesAlias = aliases.some((alias) => alias.toLowerCase() === wanted);
      if (matchesName || matchesAlias) {
        const resolvedId = this.store.resolveAlias(hit.nodeId);
        const resolved = this.nodeToApi(this.store.getNode(resolvedId)!);
        return {
          name: resolved.name,
          id: resolved.id,
          isClass: resolved.isClass,
          isEmbedded: resolved.isEmbedded,
          parentId: resolved.parentId,
        };
      }
    }
    throw new CliError(EXIT.domain, `no node named "${name}"`);
  }

  // --- write projections ----------------------------------------------------

  /** object.create / class.create from the retired REST create body. */
  async createObject(
    body: Record<string, unknown>,
    options: { push?: boolean | undefined } = {},
  ): Promise<{ id: string; object: unknown }> {
    const { id, name, contentAst, isClass, isEmbedded, parentId, classIds } = body as {
      id?: string;
      name?: string;
      contentAst?: unknown;
      isClass?: boolean;
      isEmbedded?: boolean;
      parentId?: string;
      classIds?: string[];
    };
    const objectId = id ?? newObjectId();
    if (body.id !== undefined && this.store.getNode(objectId) !== undefined) {
      throw new CliError(EXIT.conflict, `object ${objectId} already exists`);
    }
    const initialText =
      name !== undefined && contentAst === undefined ? [{ type: "text", text: name }] : undefined;
    if (isClass === true) {
      if (parentId !== undefined || (classIds ?? []).length > 0 || isEmbedded !== undefined) {
        throw new CliError(EXIT.domain, "isClass cannot combine with parentId, classIds, or isEmbedded (classes are roots)");
      }
      await this.submit(
        "class.create",
        {
          classId: objectId,
          ...(initialText !== undefined ? { contentAst: initialText } : {}),
          ...(contentAst !== undefined ? { contentAst } : {}),
        },
        [objectId],
        { push: options.push },
      );
      return { id: objectId, object: this.fullObject(this.requireNode(objectId)) };
    }
    await this.submit(
      "object.create",
      {
        objectId,
        ...(isEmbedded !== undefined ? { isEmbedded } : {}),
        ...(initialText !== undefined ? { contentAst: initialText } : {}),
        ...(contentAst !== undefined ? { contentAst } : {}),
        classIds: classIds ?? [],
        ...(parentId !== undefined ? { parentId } : {}),
      },
      [objectId],
      { push: options.push },
    );
    return { id: objectId, object: this.fullObject(this.requireNode(objectId)) };
  }

  /** object.update from the retired REST patch body. */
  async updateObject(id: string, body: Record<string, unknown>): Promise<{ object: unknown }> {
    this.requireNode(id);
    await this.submit("object.update", { objectId: id, ...body }, [id]);
    return { object: this.fullObject(this.requireNode(id)) };
  }

  async deleteObject(id: string, options: { permanent?: boolean }): Promise<{ id: string; deleted: boolean; permanent: boolean }> {
    this.requireNode(id);
    const permanent = options.permanent === true;
    await this.submit("object.delete", { objectId: id, permanent }, [id]);
    return { id, deleted: true, permanent };
  }

  async restoreObject(id: string): Promise<{ object: unknown }> {
    this.requireNode(id);
    await this.submit("object.restore", { objectId: id }, [id]);
    return { object: this.fullObject(this.requireNode(id)) };
  }

  /** object merge: the store's planMerge, then the plan's ops in order. */
  async mergeObjects(
    sourceId: string,
    targetId: string,
    options: { dryRun?: boolean },
  ): Promise<{ dryRun: true; summary: unknown } | { merged: boolean; targetId: string; summary: unknown }> {
    this.requireNode(sourceId);
    let plan;
    try {
      plan = planMerge(this.store.database, sourceId, targetId);
    } catch (error) {
      if (error instanceof MergeGuardError) {
        throw new CliError(EXIT.domain, error.message);
      }
      throw error;
    }
    if (options.dryRun === true) {
      return { dryRun: true, summary: plan.summary };
    }
    for (const op of plan.ops) {
      await this.submit(op.opType, op.payload, [sourceId, targetId]);
    }
    return { merged: true, targetId, summary: plan.summary };
  }

  async assignClass(objectId: string, classId: string): Promise<{ object: unknown }> {
    const row = this.requireNode(objectId);
    if (row.is_class === 1) {
      throw new CliError(EXIT.domain, "a class node is not a class member (identity is the is_class bit)");
    }
    this.requireClass(classId);
    // The OR-Set add-wins seed rides the re-issued object.create carrier.
    await this.submit("object.create", { objectId, classIds: [classId] }, [objectId]);
    return { object: this.fullObject(this.requireNode(objectId)) };
  }

  async unassignClass(objectId: string, classId: string): Promise<{ object: unknown }> {
    this.requireNode(objectId);
    this.requireClass(classId);
    await this.submit("class.unassign", { objectId, classId }, [objectId]);
    return { object: this.fullObject(this.requireNode(objectId)) };
  }

  async assignTag(objectId: string, tagId: string): Promise<{ object: unknown }> {
    this.requireNode(objectId);
    const tagRow = this.requireNode(tagId);
    if (tagRow.is_class === 1) {
      throw new CliError(EXIT.domain, "a class node is not a tag (tags are pages)");
    }
    await this.submit("object.create", { objectId, tagIds: [tagId] }, [objectId]);
    return { object: this.fullObject(this.requireNode(objectId)) };
  }

  async unassignTag(objectId: string, tagId: string): Promise<{ object: unknown }> {
    this.requireNode(objectId);
    this.requireNode(tagId);
    await this.submit("tag.unassign", { objectId, tagId }, [objectId]);
    return { object: this.fullObject(this.requireNode(objectId)) };
  }

  async setProperty(
    objectId: string,
    body: Record<string, unknown>,
    options: { push?: boolean | undefined } = {},
  ): Promise<{ object: unknown }> {
    this.requireNode(objectId);
    await this.submit("property.set", { objectId, ...body }, [objectId], options);
    return { object: this.fullObject(this.requireNode(objectId)) };
  }

  async unsetProperty(
    objectId: string,
    propertySchemaId: string,
    idx: number,
    options: { push?: boolean | undefined } = {},
  ): Promise<{ object: unknown }> {
    this.requireNode(objectId);
    await this.submit("property.unset", { objectId, propertySchemaId, idx }, [objectId], options);
    return { object: this.fullObject(this.requireNode(objectId)) };
  }

  // --- row projections ------------------------------------------------------

  private requireNode(id: string): NodeRow {
    const row = this.store.getNode(id);
    if (row === undefined) {
      throw new CliError(EXIT.domain, `object ${id} does not exist`, { status: 404 });
    }
    return row;
  }

  private requireClass(id: string): void {
    const row = this.store.database.prepare("SELECT 1 FROM class WHERE id = ? AND active = 1").get(id);
    if (row === undefined) {
      throw new CliError(EXIT.domain, `class ${id} does not exist`);
    }
  }

  private nodeToApi(row: NodeRow): ApiObject {
    const resolveMentionName = this.mentionNameResolver();
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      isClass: row.is_class === 1,
      isEmbedded: row.is_embedded === 1,
      parentId: row.parent_id,
      classIds: JSON.parse(row.class_ids) as string[],
      tagIds: JSON.parse(row.tag_ids) as string[],
      name:
        fullTitleOf(
          {
            id: row.id,
            isClass: row.is_class,
            isEmbedded: row.is_embedded,
            contentAst: contentAstOf(row),
            classIds: JSON.parse(row.class_ids) as string[],
          },
          undefined,
          resolveMentionName,
        ) || null,
      icon: row.icon,
      color: row.color,
      coverAssetId: row.cover_asset_id,
      bannerAssetId: row.banner_asset_id,
      aliasedNodeId: row.aliased_node_id,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
    };
  }

  /**
   * The store-backed mention resolver: a bare mention's label is its
   * target's CURRENT title, recursive with a path guard so a mention cycle
   * folds to nothing at the loop point instead of hanging.
   */
  private mentionNameResolver(): (targetNodeId: string) => string | null {
    const stmt = this.store.database.prepare("SELECT id, content, class_ids FROM node WHERE id = ?");
    const resolve = (id: string, path: Set<string>): string | null => {
      if (path.has(id)) return null;
      const row = stmt.get(id) as { id: string; content: string | null; class_ids: string | null } | undefined;
      if (row === undefined) return null;
      path.add(id);
      const name = fullTitleOf(
        {
          id: row.id,
          contentAst: (row.content === null ? [] : (JSON.parse(row.content) as ContentAst)) as ContentAst,
          classIds: row.class_ids === null ? [] : (JSON.parse(row.class_ids) as string[]),
        },
        undefined,
        (targetId) => resolve(targetId, path),
      );
      path.delete(id);
      return name === "" ? null : name;
    };
    return (id) => resolve(id, new Set());
  }

  /** The full object projection behind the retired GET /objects/:id. */
  fullObject(row: NodeRow): Record<string, unknown> {
    const resolveMentionName = this.mentionNameResolver();
    const base = this.nodeToApi(row);
    const classes = base.classIds
      .map((classId) => {
        const classRow = this.store.database
          .prepare(
            `SELECT c.id, c.name, c.icon, c.color, n.content AS nodeContent, n.class_ids AS nodeClassIds
             FROM class c LEFT JOIN node n ON n.id = c.id AND n.is_active = 1
             WHERE c.id = ? AND c.active = 1`,
          )
          .get(classId) as
          | { id: string; name: string; icon: string | null; color: string | null; nodeContent: string | null; nodeClassIds: string | null }
          | undefined;
        if (classRow === undefined) return null;
        return {
          id: classRow.id,
          name: classNameFromNode(classRow.nodeContent, classRow.nodeClassIds, classRow.name),
          icon: classRow.icon,
          color: classRow.color,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const tags = base.tagIds
      .map((tagId) => {
        const tagRow = this.store.database
          .prepare("SELECT id, content, class_ids, color FROM node WHERE id = ? AND is_active = 1")
          .get(tagId) as
          | { id: string; content: string | null; class_ids: string | null; color: string | null }
          | undefined;
        if (tagRow === undefined) return null;
        const name =
          fullTitleOf(
            {
              id: tagRow.id,
              isClass: 0,
              isEmbedded: 0,
              contentAst: (tagRow.content === null ? [] : (JSON.parse(tagRow.content) as ContentAst)) as ContentAst,
              classIds: JSON.parse(tagRow.class_ids ?? "[]") as string[],
            },
            undefined,
            resolveMentionName,
          ) || null;
        return { id: tagRow.id, name, color: tagRow.color };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const properties = visiblePropertyValueRows(this.store.database, row.id)
      .map((property) => {
        const schema = this.store.database
          .prepare("SELECT id, name, type FROM property_schema WHERE id = ?")
          .get(property.property_schema_id) as
          | { id: string; name: string; type: string }
          | undefined;
        if (schema === undefined) return null;
        return { property, schema };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort(
        (a, b) =>
          a.schema.name.localeCompare(b.schema.name) ||
          a.property.idx - b.property.idx ||
          (a.property.id < b.property.id ? -1 : 1),
      )
      .map(({ property, schema }) => ({
        schemaId: schema.id,
        schemaName: schema.name,
        schemaType: schema.type,
        elementId: property.id,
        idx: property.idx,
        value: JSON.parse(property.value) as unknown,
        ...(property.metadata !== null ? { metadata: JSON.parse(property.metadata) as unknown } : {}),
      }));
    const contentAst = JSON.parse(row.content) as unknown;
    return { ...base, contentAst, classes, tags, properties };
  }
}

/**
 * Class title read model (title-is-content): the display name derives from
 * the class NODE's content; the registry `name` is a write-side denormalized
 * cache — a fallback only, never the source of truth.
 */
function classNameFromNode(nodeContent: string | null, nodeClassIds: string | null, cachedName: string): string {
  if (nodeContent !== null) {
    const derived = deriveDisplayName({
      id: "",
      isClass: 1,
      isEmbedded: 0,
      contentAst: JSON.parse(nodeContent) as ContentAst,
      classIds: JSON.parse(nodeClassIds ?? "[]") as string[],
    });
    if (derived) return derived;
  }
  return cachedName;
}

/** Fresh object id — uuidv7 by the identity design law. */
function newObjectId(): string {
  return uuidv7();
}

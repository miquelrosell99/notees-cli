/**
 * The keyed-workspace custody cache: `resolveKeyedCrypto` must resolve the
 * envelope crypto from the cached master key without the password (the web
 * client's persisted-custody parity), fall back to NOTEES_EMAIL +
 * NOTEES_PASSWORD on first use (caching the bytes), and treat a stale cache
 * as a cache miss. Pure seam tests: a fake fetch serves the custody
 * endpoints, the protocol crypto runs for real (scrypt N=131072 — a few
 * hundred ms per unwrap, fine at this scale).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  b64uDecode,
  b64uEncode,
  createKdfRecord,
  generateMasterKey,
  generateWorkspaceKey,
  masterKeyFp,
  wrapWorkspaceKey,
} from "@notees/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError, EXIT } from "../src/exit-codes.js";
import { resolveKeyedCrypto } from "../src/local-workspace.js";
import { cachedMasterKey, clearCachedMasterKey, storeCachedMasterKey } from "../src/state.js";

const BASE = "http://custody.test";
const API_KEY = "nk_test";
const WORKSPACE_ID = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const PASSWORD = "correct horse battery staple";

let dir: string;
let statePath: string;
let stateKey: string;
let masterFp: string;

interface FetchLog {
  unlockCalls: number;
  keyCalls: number;
}

/** A fake fetch serving the custody endpoints and counting oracle calls. */
function fakeFetch(wrappedKey: string, log: FetchLog, kdfOverride?: unknown): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE}/api/auth/unlock`) {
      log.unlockCalls += 1;
      const body = JSON.parse(String(init?.body)) as { email: string; password: string };
      if (body.password !== PASSWORD) {
        return new Response(JSON.stringify({ error: { code: "unauthenticated", message: "nope", status: 401 } }), { status: 401 });
      }
      return new Response(JSON.stringify({ kdf: kdfOverride ?? null }), { status: 200 });
    }
    if (url === `${BASE}/api/workspaces/${WORKSPACE_ID}/key`) {
      log.keyCalls += 1;
      return new Response(JSON.stringify({ wrappedKey }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function buildWrapped(): Promise<{ wrappedKey: string; kdf: Awaited<ReturnType<typeof createKdfRecord>> }> {
  const master = await generateMasterKey();
  const kdf = await createKdfRecord(master, PASSWORD);
  const workspaceKey = await generateWorkspaceKey();
  const wrappedKey = await wrapWorkspaceKey(master, workspaceKey);
  masterFp = masterKeyFp(new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", master as never)));
  return { wrappedKey, kdf };
}

function cachedFp(): string | undefined {
  const cached = cachedMasterKey(statePath, stateKey);
  return cached === undefined ? undefined : masterKeyFp(b64uDecode(cached.bytes));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "notees-key-cache-test-"));
  statePath = join(dir, "state.json");
  stateKey = "default:http://localhost:8377";
  delete process.env.NOTEES_EMAIL;
  delete process.env.NOTEES_PASSWORD;
});

afterEach(() => {
  delete process.env.NOTEES_EMAIL;
  delete process.env.NOTEES_PASSWORD;
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveKeyedCrypto (master-key cache)", () => {
  it("with no cache and no password env fails loud, pointing at the unlock path", async () => {
    const { wrappedKey, kdf } = await buildWrapped();
    const log: FetchLog = { unlockCalls: 0, keyCalls: 0 };
    const failure = await resolveKeyedCrypto({
      base: BASE,
      apiKey: API_KEY,
      workspaceId: WORKSPACE_ID,
      wrappedKey,
      fetchImpl: fakeFetch(wrappedKey, log, kdf),
      statePath,
      stateKey,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).exitCode).toBe(EXIT.auth);
    expect((failure as CliError).message).toContain("NOTEES_EMAIL");
    expect((failure as CliError).message).toContain("notees auth unlock");
    // The password oracle was never consulted.
    expect(log.unlockCalls).toBe(0);
  });

  it("password path unwraps, caches the master key, and never re-asks the oracle on a cache hit", async () => {
    const { wrappedKey, kdf } = await buildWrapped();
    const log: FetchLog = { unlockCalls: 0, keyCalls: 0 };
    process.env.NOTEES_EMAIL = "cli-ws@example.test";
    process.env.NOTEES_PASSWORD = PASSWORD;

    const first = await resolveKeyedCrypto({
      base: BASE,
      apiKey: API_KEY,
      workspaceId: WORKSPACE_ID,
      wrappedKey,
      fetchImpl: fakeFetch(wrappedKey, log, kdf),
      statePath,
      stateKey,
    });
    expect(first.source).toBe("password");
    expect(log.unlockCalls).toBe(1);
    expect(cachedFp()).toBe(masterFp);
    // The state file is valid JSON in the servers map, mode-0600 territory.
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as {
      servers: Record<string, { masterKey?: { bytes: string; updatedAt: string } }>;
    };
    expect(saved.servers[stateKey]?.masterKey?.bytes).toBeDefined();

    // Second run with NO password: the cache answers, the oracle is not called.
    delete process.env.NOTEES_EMAIL;
    delete process.env.NOTEES_PASSWORD;
    const second = await resolveKeyedCrypto({
      base: BASE,
      apiKey: API_KEY,
      workspaceId: WORKSPACE_ID,
      wrappedKey,
      fetchImpl: fakeFetch(wrappedKey, log, kdf),
      statePath,
      stateKey,
    });
    expect(second.source).toBe("cache");
    expect(log.unlockCalls).toBe(1);
  });

  it("a stale cache (rotated key) falls back to the password path and overwrites the cache", async () => {
    const { wrappedKey, kdf } = await buildWrapped();
    const log: FetchLog = { unlockCalls: 0, keyCalls: 0 };
    storeCachedMasterKey(statePath, stateKey, b64uEncode(new Uint8Array(32).fill(7)));
    process.env.NOTEES_EMAIL = "cli-ws@example.test";
    process.env.NOTEES_PASSWORD = PASSWORD;

    const resolved = await resolveKeyedCrypto({
      base: BASE,
      apiKey: API_KEY,
      workspaceId: WORKSPACE_ID,
      wrappedKey,
      fetchImpl: fakeFetch(wrappedKey, log, kdf),
      statePath,
      stateKey,
    });
    expect(resolved.source).toBe("password");
    expect(cachedFp()).toBe(masterFp);
  });

  it("a wrong password surfaces the oracle's 401 as an auth error", async () => {
    const { wrappedKey, kdf } = await buildWrapped();
    const log: FetchLog = { unlockCalls: 0, keyCalls: 0 };
    process.env.NOTEES_EMAIL = "cli-ws@example.test";
    process.env.NOTEES_PASSWORD = "wrong password";

    const failure = await resolveKeyedCrypto({
      base: BASE,
      apiKey: API_KEY,
      workspaceId: WORKSPACE_ID,
      wrappedKey,
      fetchImpl: fakeFetch(wrappedKey, log, kdf),
      statePath,
      stateKey,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).exitCode).toBe(EXIT.auth);
    expect(log.unlockCalls).toBe(1);
  });

  it("without the state seams the cache is skipped and the password path still works", async () => {
    const { wrappedKey, kdf } = await buildWrapped();
    const log: FetchLog = { unlockCalls: 0, keyCalls: 0 };
    process.env.NOTEES_EMAIL = "cli-ws@example.test";
    process.env.NOTEES_PASSWORD = PASSWORD;

    const resolved = await resolveKeyedCrypto({
      base: BASE,
      apiKey: API_KEY,
      workspaceId: WORKSPACE_ID,
      wrappedKey,
      fetchImpl: fakeFetch(wrappedKey, log, kdf),
    });
    expect(resolved.source).toBe("password");
    expect(cachedMasterKey(statePath, stateKey)).toBeUndefined();
  });
});

describe("state master-key cache helpers", () => {
  it("store → read → clear round-trip; clear on an empty slot reports false", () => {
    expect(clearCachedMasterKey(statePath, stateKey)).toBe(false);
    storeCachedMasterKey(statePath, stateKey, "dGVzdA");
    expect(cachedMasterKey(statePath, stateKey)?.bytes).toBe("dGVzdA");
    expect(clearCachedMasterKey(statePath, stateKey)).toBe(true);
    expect(cachedMasterKey(statePath, stateKey)).toBeUndefined();
  });
});

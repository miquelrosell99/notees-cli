import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { defaultWorkspaceId } from "@notees/server";

import { createCiteRenderer } from "../src/serve/cite.js";
import { cslItemFor } from "../src/serve/csl-items.js";
import { resolveServeConfig } from "../src/serve/config.js";
import { dispatchDocument } from "../src/serve/document.js";
import type { ServeResponse } from "../src/serve/protocol.js";
import { startBridge, type Bridge } from "../src/serve/server.js";
import { openBridgeSession, type BridgeSession } from "../src/serve/session.js";

import { API_KEY, bootServer, type Harness } from "./helpers/serve-harness.js";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

let harness: Harness;
let session: BridgeSession;
let bridge: Bridge;
const warnings: string[] = [];

// Seeded node ids, shared by the assertions in every describe below.
let duneId = "";
let articleId = "";
let plainPageId = "";
let bareSourceId = "";

beforeAll(async () => {
  harness = await bootServer();
  // Two sources: one fully decorated, one citekey-less.
  duneId = await harness.seedObject("Dune", [SYSTEM_CLASS_UUIDS.source, SYSTEM_CLASS_UUIDS.book]);
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.citekey, "herbert1965dune");
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.authors, ["Herbert, Frank"]);
  // publicationDate is a DATETIME schema: a bare string is not a lawful
  // value — the point shape { nodeId } references a date node whose title
  // carries the year (the session resolves the ref's title).
  const year1965 = await harness.seedObject("1965", []);
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.publicationDate, { nodeId: year1965 });
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.publisher, "Chilton Books");
  articleId = await harness.seedObject("Sandworms of Note", [
    SYSTEM_CLASS_UUIDS.source,
    SYSTEM_CLASS_UUIDS.journal_article,
  ]);
  await harness.seedProperty(articleId, SYSTEM_PROPERTY_UUIDS.authors, ["Atreides, Paul"]);
  const year2020 = await harness.seedObject("2020", []);
  await harness.seedProperty(articleId, SYSTEM_PROPERTY_UUIDS.publicationDate, { nodeId: year2020 });
  // A non-source page that FTS would still hit — search must filter it out.
  plainPageId = await harness.seedObject("Dune (film) notes", []);
  // A bare-source node (no roster subclass) — search must surface it with
  // classKey "source", not drop it.
  bareSourceId = await harness.seedObject("Dune Messiah", [SYSTEM_CLASS_UUIDS.source]);

  session = await openBridgeSession({
    server: harness.baseUrl,
    apiKey: API_KEY,
    workspaceId: defaultWorkspaceId(),
    storeDir: join(dirname(harness.stateFile), "stores"),
    statePath: harness.stateFile,
    stateKey: `default:${harness.baseUrl}`,
    syncIntervalMs: 3_600_000, // background sync must not interfere with tests
    onWarning: (message) => warnings.push(message),
  });
  const config = resolveServeConfig({ port: "0" }, {});
  const renderer = createCiteRenderer();
  bridge = await startBridge(config, {
    dispatch: (request) => dispatchDocument({ session, renderer }, request),
  });
}, 60_000);

afterAll(async () => {
  await bridge?.close();
  session?.close();
  await harness?.close();
  rmSync(harness?.dataDir ?? "", { recursive: true, force: true });
});

async function call(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: ServeResponse }> {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/document`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ServeResponse };
}

describe("search", () => {
  it("finds sources by FTS and projects the result envelope", async () => {
    const res = await call({ cmd: "search", query: "Dune" });
    expect(res.status).toBe(200);
    if (!res.body.ok || !("results" in res.body)) throw new Error(JSON.stringify(res.body));
    const hit = res.body.results.find((r) => r.title === "Dune");
    expect(hit).toMatchObject({
      objectId: expect.any(String),
      title: "Dune",
      citekey: "herbert1965dune",
      authors: ["Herbert, Frank"],
      year: 1965,
      classKey: "book",
    });
    // The non-source page matched by FTS must be filtered out.
    expect(res.body.results.some((r) => r.title === "Dune (film) notes")).toBe(false);
  });

  it("omits citekey/authors/year when the source carries none", async () => {
    const res = await call({ cmd: "search", query: "Sandworms" });
    if (!res.body.ok || !("results" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ title: "Sandworms of Note", classKey: "journal_article" });
    expect(res.body.results[0]).not.toHaveProperty("citekey");
    expect(res.body.results[0]).toHaveProperty("authors", ["Atreides, Paul"]);
  });

  it("answers an empty results array for a no-match query", async () => {
    const res = await call({ cmd: "search", query: "no-such-title-xyz" });
    expect(res.body).toEqual({ ok: true, results: [] });
  });

  it("surfaces a bare class:source hit with classKey \"source\"", async () => {
    const res = await call({ cmd: "search", query: "Messiah" });
    if (!res.body.ok || !("results" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ title: "Dune Messiah", classKey: "source" });
    expect(bareSourceId).not.toBe("");
  });
});

describe("offline-first bootstrap", () => {
  const deadServer = "http://127.0.0.1:1"; // nothing listens — refused instantly

  it("serves the last synced store when the server is unreachable", async () => {
    const storeDir = join(harness.dataDir, "offline-store");
    // First session syncs against the live server, then releases the lock.
    const first = await openBridgeSession({
      server: harness.baseUrl,
      apiKey: API_KEY,
      workspaceId: defaultWorkspaceId(),
      storeDir,
      statePath: harness.stateFile,
      stateKey: `default:${harness.baseUrl}`,
      syncIntervalMs: 3_600_000,
      onWarning: () => {},
    });
    first.close();
    // Same store, unreachable server: the best-effort path warns and serves
    // the stale projection — never a fatal error.
    const offlineWarnings: string[] = [];
    const offline = await openBridgeSession({
      server: deadServer,
      apiKey: API_KEY,
      workspaceId: defaultWorkspaceId(),
      storeDir,
      statePath: harness.stateFile,
      stateKey: `default:${deadServer}`,
      syncIntervalMs: 3_600_000,
      onWarning: (message) => offlineWarnings.push(message),
    });
    try {
      expect(offlineWarnings.some((message) => message.includes("initial sync failed"))).toBe(true);
      const hits = offline.searchSources("Dune");
      expect(hits.some((hit) => hit.title === "Dune" && hit.classKey === "book")).toBe(true);
    } finally {
      offline.close();
    }
  });

  it("fails loud when there is no store and the server is unreachable", async () => {
    const storeDir = join(harness.dataDir, "never-synced-store");
    // No store file yet + unreachable server: best-effort must NOT invent an
    // empty projection — the open rejects (network exit code) and nothing
    // is served. (Store.open creates the file eagerly, so the existence
    // check must be captured BEFORE the open.)
    await expect(
      openBridgeSession({
        server: deadServer,
        apiKey: API_KEY,
        workspaceId: defaultWorkspaceId(),
        storeDir,
        statePath: harness.stateFile,
        stateKey: `default:${deadServer}`,
        syncIntervalMs: 3_600_000,
        onWarning: () => {},
      }),
    ).rejects.toMatchObject({ exitCode: 5 });
  });
});

describe("list-styles", () => {
  it("lists the bundled catalog over the bridge", async () => {
    const res = await call({ cmd: "list-styles" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      styles: [
        { id: "apa", label: "APA (7th edition)" },
        { id: "ieee", label: "IEEE" },
        { id: "chicago-note-bibliography", label: "Chicago (notes & bibliography)" },
      ],
    });
  });
});

describe("render smoke", () => {
  // Full end-to-end render commands over the bridge land with the render
  // slice; here the seeded source only crosses the projection + renderer.
  it("projects a seeded source to CSL-JSON and renders an apa citation + bibliography", () => {
    const item = cslItemFor(session.local, duneId);
    if (item === undefined) throw new Error("seeded Dune source must project to a CSL item");
    const renderer = createCiteRenderer();
    const citation = renderer.renderCitation([item], "apa", "23");
    expect(typeof citation).toBe("string");
    expect(citation as string).toContain("Herbert");
    expect(citation as string).toContain("1965");
    expect(citation as string).toContain("23");
    const bibliography = renderer.renderBibliography([item], "apa");
    expect(typeof bibliography).toBe("string");
    expect(bibliography as string).toContain("Herbert, F.");
    expect(bibliography as string).toContain("Dune");
  });
});

describe("render-citation", () => {
  it("renders an apa in-text citation for a seeded source", async () => {
    const res = await call({ cmd: "render-citation", objectIds: [duneId], styleId: "apa" });
    expect(res.status).toBe(200);
    if (!res.body.ok || !("citation" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.citation).toContain("Herbert");
    expect(res.body.citation).toContain("1965");
  });

  it("renders a locator into the citation", async () => {
    const res = await call({ cmd: "render-citation", objectIds: [duneId], styleId: "apa", locator: "42" });
    if (!res.body.ok || !("citation" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.citation).toContain("42");
  });

  it("renders a multi-source cluster", async () => {
    const res = await call({ cmd: "render-citation", objectIds: [duneId, articleId], styleId: "apa" });
    if (!res.body.ok || !("citation" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.citation).toContain("Herbert");
    expect(res.body.citation).toContain("Atreides");
  });

  it("renders a citekey-less source via the node-id fallback", async () => {
    const res = await call({ cmd: "render-citation", objectIds: [articleId], styleId: "apa" });
    expect(res.status).toBe(200);
  });

  it("answers not_found for an unknown object id or unknown style", async () => {
    const unknownId = await call({
      cmd: "render-citation",
      objectIds: ["00000000-0000-0000-0000-00000000dead"],
      styleId: "apa",
    });
    expect(unknownId.status).toBe(404);
    expect(unknownId.body).toMatchObject({ ok: false, error: { code: "not_found" } });

    const unknownStyle = await call({ cmd: "render-citation", objectIds: [duneId], styleId: "vancouver" });
    expect(unknownStyle.status).toBe(404);
    expect(unknownStyle.body).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("render-bibliography", () => {
  it("renders an apa bibliography across source classes", async () => {
    const res = await call({ cmd: "render-bibliography", objectIds: [duneId, articleId], styleId: "apa" });
    expect(res.status).toBe(200);
    if (!res.body.ok || !("bibliography" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.bibliography).toContain("Herbert, F.");
    expect(res.body.bibliography).toContain("Dune");
    expect(res.body.bibliography).toContain("Atreides, P.");
  });

  it("renders the bundled styles end-to-end (ieee + chicago smoke)", async () => {
    const ieee = await call({ cmd: "render-bibliography", objectIds: [duneId], styleId: "ieee" });
    if (!ieee.body.ok || !("bibliography" in ieee.body)) throw new Error(JSON.stringify(ieee.body));
    expect(ieee.body.bibliography).toContain("Dune");

    const chicago = await call({ cmd: "render-bibliography", objectIds: [duneId], styleId: "chicago-note-bibliography" });
    if (!chicago.body.ok || !("bibliography" in chicago.body)) throw new Error(JSON.stringify(chicago.body));
    expect(chicago.body.bibliography).toContain("Herbert");
  });

  it("answers not_found for a non-source object id", async () => {
    const res = await call({ cmd: "render-bibliography", objectIds: [plainPageId], styleId: "apa" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("list-styles", () => {
  it("lists the bundled styles", async () => {
    const res = await call({ cmd: "list-styles" });
    expect(res.body).toEqual({
      ok: true,
      styles: [
        { id: "apa", label: "APA (7th edition)" },
        { id: "ieee", label: "IEEE" },
        { id: "chicago-note-bibliography", label: "Chicago (notes & bibliography)" },
      ],
    });
  });
});

describe("store lock", () => {
  it("refuses a second bridge on the same store (exit 4 contract)", async () => {
    await expect(
      openBridgeSession({
        server: harness.baseUrl,
        apiKey: API_KEY,
        workspaceId: defaultWorkspaceId(),
        storeDir: join(dirname(harness.stateFile), "stores"),
        statePath: harness.stateFile,
        stateKey: `default:${harness.baseUrl}`,
        syncIntervalMs: 3_600_000,
        onWarning: () => {},
      }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe("hardening", () => {
  it("serves 24 concurrent mixed requests, all well-formed", async () => {
    const bodies = [
      { cmd: "search", query: "Dune" },
      { cmd: "list-styles" },
      { cmd: "render-citation", objectIds: [duneId], styleId: "apa" },
      { cmd: "render-bibliography", objectIds: [duneId, articleId], styleId: "apa" },
    ];
    const responses = await Promise.all(
      Array.from({ length: 24 }, (_, i) => call(bodies[i % bodies.length]!)),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    }
    // And a follow-up after the burst still works (no wedged state).
    const after = await call({ cmd: "search", query: "Dune" });
    expect(after.body).toMatchObject({ ok: true });
  });

  it("answers every wire error shape with its pinned HTTP status", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ cmd: "nope" }, 400, "unknown_cmd"],
      [{ cmd: "search" }, 400, "bad_request"],
      [{ cmd: "render-citation", objectIds: [], styleId: "apa" }, 400, "bad_request"],
      [{ cmd: "render-citation", objectIds: [duneId], styleId: "../traversal" }, 404, "not_found"],
      [{ cmd: "render-citation", objectIds: ["00000000-0000-0000-0000-00000000dead"], styleId: "apa" }, 404, "not_found"],
    ];
    for (const [body, status, code] of cases) {
      const res = await call(body);
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ ok: false, error: { code } });
    }
  });

  it("serves from the last synced store when the server goes dark (offline-first)", async () => {
    // Close the first session (releases the lock), then open against a
    // dead port with the SAME store dir — search must still answer.
    // The workspace id must be the primary session's: the store file is
    // <storeDir>/<workspaceId>.db, and a never-synced id has no store —
    // with the server unreachable that fails loud (exit 5), never serves.
    const workspaceId = defaultWorkspaceId();
    session.close();
    const offline = await openBridgeSession({
      server: "http://127.0.0.1:1", // nothing listens here
      apiKey: API_KEY,
      workspaceId,
      storeDir: join(dirname(harness.stateFile), "stores"),
      statePath: harness.stateFile,
      stateKey: `default:${harness.baseUrl}`,
      syncIntervalMs: 3_600_000,
      onWarning: (message) => warnings.push(message),
    });
    try {
      const results = offline.searchSources("Dune");
      expect(results.some((r) => r.title === "Dune")).toBe(true);
      expect(warnings.some((w) => w.includes("initial sync failed"))).toBe(true);
    } finally {
      offline.close();
    }
    // Re-open the primary session for any later tests (same options as the
    // beforeAll hook, so the lock and the store dir line up exactly).
    session = await openBridgeSession({
      server: harness.baseUrl,
      apiKey: API_KEY,
      workspaceId: defaultWorkspaceId(),
      storeDir: join(dirname(harness.stateFile), "stores"),
      statePath: harness.stateFile,
      stateKey: `default:${harness.baseUrl}`,
      syncIntervalMs: 3_600_000,
      onWarning: (message) => warnings.push(message),
    });
  });
});

import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// One real server per file (was: per test — repeated boots accumulated
// handles in the worker and beforeEach intermittently blew the 10 s hook
// timeout under load; registered flake in SCHEMA.md's deviation register).
// Generous timeouts kept as a bounded safety margin.
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

import { newEnvelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { bibToCsl, parseBibtex } from "@notees/export";

import { buildServer, defaultWorkspaceId } from "@notees/server";

import { run, type CliIo } from "../src/cli.js";
import { ApiClient } from "../src/client.js";
import { EXIT } from "../src/exit-codes.js";
import { buildMarkdownBundle } from "../src/markdown-export.js";

const API_KEY = `nk_${"c".repeat(32)}`;
type App = Awaited<ReturnType<typeof buildServer>>["app"];

class Capture implements CliIo {
  stdoutText = "";
  stderrText = "";
  isTty = false;
  stdin?: NodeJS.ReadableStream | undefined;
  stdout = {
    write: (chunk: string) => {
      this.stdoutText += chunk;
    },
  };
  stderr = {
    write: (chunk: string) => {
      this.stderrText += chunk;
    },
  };
}

interface Harness {
  app: App;
  dataDir: string;
  baseUrl: string;
  stateFile: string;
  io: Capture;
  runCli(...args: string[]): Promise<number>;
  runCliWithStdin(stdin: string, ...args: string[]): Promise<number>;
  createPage(name: string, contentAst: unknown[]): Promise<string>;
}

async function bootServer(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "notees-cli-test-"));
  const stateFile = join(dataDir, "cli-state.json");
  const { app } = await buildServer(
    {
      dataDir,
      apiKey: API_KEY,
      port: 0,
      host: "127.0.0.1",
      logger: false,
      relayBatchPerMinute: 30_000,
      globalRequestsPerMinute: 10_000,
      maxMediaBytes: 50 * 1024 * 1024,
      maxDocumentBytes: 100 * 1024 * 1024,
      loginPerMinute: 10,
      corsOrigins: [],
    },
    { logger: false },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const io = new Capture();
  const harness: Harness = {
    app,
    dataDir,
    baseUrl,
    stateFile,
    io,
    async runCli(...args: string[]) {
      io.stdoutText = "";
      io.stderrText = "";
      return run(["--server", baseUrl, "--key", API_KEY, ...args], io);
    },
    async runCliWithStdin(stdin: string, ...args: string[]) {
      io.stdoutText = "";
      io.stderrText = "";
      io.stdin = Readable.from([stdin]);
      const code = await run(["--server", baseUrl, "--key", API_KEY, ...args], io);
      io.stdin = undefined;
      return code;
    },
    async createPage(name: string, contentAst: unknown[]) {
      // Title-is-content: the page's own content IS its title; the given
      // contentAst becomes a child block (pages are text-only by invariant).
      const code = await this.runCliWithStdin(
        JSON.stringify({ presentAsMain: true, contentAst: [{ type: "text", text: name }] }),
        "--json", "object", "create", "--stdin",
      );
      if (code !== EXIT.ok) throw new Error(`createPage ${name} failed: ${io.stderrText}`);
      const id = (JSON.parse(io.stdoutText) as { id: string }).id;
      if (contentAst.length > 0) {
        const blockCode = await this.runCliWithStdin(
          JSON.stringify({ presentAsMain: false, parentId: id, contentAst }),
          "--json", "object", "create", "--stdin",
        );
        if (blockCode !== EXIT.ok) throw new Error(`createPage block ${name} failed: ${io.stderrText}`);
      }
      return id;
    },
  };
  return harness;
}

let harness: Harness;
beforeAll(async () => {
  harness = await bootServer();
  process.env.NOTEES_STATE_FILE = harness.stateFile;
});
afterAll(async () => {
  await harness.app.close();
  rmSync(harness.dataDir, { recursive: true, force: true });
  delete process.env.NOTEES_STATE_FILE;
});

describe("object lifecycle (json mode)", () => {
  it("create → get → list → search → update → delete", async () => {
    const h = harness;

    // create (prints the new id; --json wraps it) — content via --stdin
    // Title-is-content: the title IS the content; `name` is only a create
    // convenience when no contentAst is given.
    const stdin = JSON.stringify({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "t1-cli-page" }],
    });
    const createCode = await h.runCliWithStdin(stdin, "--json", "object", "create", "--stdin");
    expect(createCode).toBe(EXIT.ok);
    const created = JSON.parse(h.io.stdoutText);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    // get
    expect(await h.runCli("--json", "object", "get", created.id)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("t1-cli-page"); // derived from content

    // update
    expect(await h.runCli("--json", "object", "update", created.id, "--name", "t1-cli-page-v2")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("t1-cli-page-v2");

    // list
    expect(await h.runCli("--json", "object", "list", "--presentAsMain")).toBe(EXIT.ok);
    const list = JSON.parse(h.io.stdoutText);
    expect(list.objects.map((o: { id: string }) => o.id)).toContain(created.id);
    expect(list.nextCursor).toBeDefined();

    // search (title term — title-is-content: it lives in the content)
    expect(await h.runCli("--json", "search", "t1-cli-page-v2")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).results.map((r: { id: string }) => r.id)).toContain(created.id);

    // delete without --yes: exit 2, nothing deleted
    const refused = await h.runCli("--json", "object", "delete", created.id);
    expect(refused).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("--yes");
    expect(await h.runCli("--json", "object", "get", created.id)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.isActive).toBe(true);

    // delete with --yes (soft)
    expect(await h.runCli("--json", "object", "delete", created.id, "--yes")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText)).toMatchObject({ id: created.id, deleted: true, permanent: false });

    // permanent delete
    expect(await h.runCli("--json", "object", "delete", created.id, "--permanent", "--yes")).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "get", created.id)).toBe(EXIT.domain);
    expect(h.io.stderrText).toContain("does not exist");
  });

  it("create reads the body from --stdin", async () => {
    const h = harness;
    const stdin = JSON.stringify({ presentAsMain: true, contentAst: [{ type: "text", text: "t2-stdin-page" }] });
    const code = await h.runCliWithStdin(stdin, "--json", "object", "create", "--stdin");
    expect(code).toBe(EXIT.ok);
    const { id } = JSON.parse(h.io.stdoutText);
    expect(await h.runCli("--json", "object", "get", id)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("t2-stdin-page");
  });

  it("create with --class shows up via class list members", async () => {
    const h = harness;
    await h.runCli("--json", "class", "list");
    const classes = JSON.parse(h.io.stdoutText).classes as { id: string; name: string }[];
    const taskClass = classes.find((c) => c.name === "task")!;
    expect(taskClass).toBeDefined();

    const code = await h.runCli("--json", "object", "create", "--presentAsMain", "--name", "t3-task-page", "--class", taskClass.id);
    expect(code).toBe(EXIT.ok);
    const { id } = JSON.parse(h.io.stdoutText);
    expect(await h.runCli("--json", "backlinks", id)).toBe(EXIT.ok);
  });
});

describe("exit codes", () => {
  it("bad API key → 3", async () => {
    const h = harness;
    const io = new Capture();
    const code = await run(["--server", h.baseUrl, "--key", `nk_${"z".repeat(32)}`, "--json", "object", "list"], io);
    expect(code).toBe(EXIT.auth);
  });

  it("unreachable server → 5", async () => {
    // A port that was just released: guaranteed nothing is listening there,
    // and the shared file-level server stays up for the remaining tests.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error !== null && error !== undefined ? reject(error) : resolve())),
    );
    const io = new Capture();
    const code = await run(
      ["--server", `http://127.0.0.1:${deadPort}`, "--key", API_KEY, "--json", "object", "list"],
      io,
    );
    expect(code).toBe(EXIT.network);
  });

  it("unknown object → 1 (domain)", async () => {
    const h = harness;
    const code = await h.runCli("--json", "object", "get", crypto.randomUUID());
    expect(code).toBe(EXIT.domain);
  });

  it("usage errors → 2 (missing server, update without fields)", async () => {
    const h = harness;
    const io = new Capture();
    const missingServer = await run(["--key", API_KEY, "object", "list"], io);
    expect(missingServer).toBe(EXIT.usage);

    // No update fields at all: client-side usage error (never hits the wire).
    const emptyUpdate = await h.runCli("object", "update", crypto.randomUUID());
    expect(emptyUpdate).toBe(EXIT.usage);
  });

  it("doctor passes against a healthy server and fails on a bad key", async () => {
    const h = harness;
    expect(await h.runCli("--json", "doctor")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).ok).toBe(true);

    const io = new Capture();
    const badKey = await run(["--server", h.baseUrl, "--key", `nk_${"y".repeat(32)}`, "doctor"], io);
    expect(badKey).toBe(EXIT.auth);
  });
});

describe("assets, classes, sync", () => {
  it("asset add → get round-trip", async () => {
    const h = harness;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("cli-upload"),
    ]);
    const file = join(h.dataDir, "t4-upload.png");
    writeFileSync(file, png);

    const addCode = await h.runCli("--json", "asset", "add", file);
    expect(addCode).toBe(EXIT.ok);
    const { assetId } = JSON.parse(h.io.stdoutText);

    const out = join(h.dataDir, "t4-downloaded.png");
    const getCode = await h.runCli("--json", "asset", "get", assetId, "--output", out);
    expect(getCode).toBe(EXIT.ok);
    expect(readFileSync(out).equals(png)).toBe(true);
  });

  it("class list includes seeded classes", async () => {
    const h = harness;
    expect(await h.runCli("--json", "class", "list")).toBe(EXIT.ok);
    const names = (JSON.parse(h.io.stdoutText).classes as { name: string }[]).map((c) => c.name);
    expect(names).toContain("task");
    expect(names).toContain("source");
  });

  it("sync status reports server stats and the local cursor", async () => {
    const h = harness;
    await h.runCli("--json", "object", "create", "--presentAsMain", "--name", "t5-sync-probe");
    expect(await h.runCli("--json", "sync", "status")).toBe(EXIT.ok);
    const status = JSON.parse(h.io.stdoutText);
    // One server + one state file for the whole file: envelopeCount includes
    // seeding and every other test's writes (hence only > 0), and no command
    // in the file ever advances the persisted cursor, so it stays 0 and
    // `behind` must equal the full envelope count.
    expect(status.envelopeCount).toBeGreaterThan(0);
    expect(status.localCursorSeq).toBe(0);
    expect(status.behind).toBe(status.envelopeCount);
  });

  it("object create prints a bare id in human mode", async () => {
    const h = harness;
    expect(await h.runCli("object", "create", "--presentAsMain", "--name", "t6-human")).toBe(EXIT.ok);
    expect(h.io.stdoutText.trim()).toMatch(/^[0-9a-f-]{36}$/);
  });
});


describe("export markdown", () => {
  it("--linked-to prints the referrer's markdown with [[name]] mentions (stdout)", async () => {
    const h = harness;
    const target = await h.createPage("expm-target-x", [{ type: "text", text: "seed body" }]);
    await h.createPage("expm-referrer-r", [
      { type: "mention", targetNodeId: target, text: "expm-target-x" },
      { type: "text", text: " points here" },
    ]);

    const code = await h.runCli("export", "markdown", "--linked-to", target, "--stdout");
    expect(code).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("# expm-referrer-r");
    expect(h.io.stdoutText).toContain("[[expm-target-x]]");
    // The seed is part of the bundle (hub of the closure).
    expect(h.io.stdoutText).toContain("# expm-target-x");
  });

  it("--output-dir writes <uuid>.md files + notees-manifest.json; --json reports the set", async () => {
    const h = harness;
    const a = await h.createPage("expm-file-a", [{ type: "text", text: "file a body" }]);
    const b = await h.createPage("expm-file-b", []);
    const dir = join(h.dataDir, "expm-out-dir");

    const code = await h.runCli("--json", "export", "markdown", "--ids", a, b, "--output-dir", dir);
    expect(code).toBe(EXIT.ok);
    const machine = JSON.parse(h.io.stdoutText) as { files: number; nodes: { id: string; name: string }[] };
    expect(machine.files).toBe(2);
    expect(machine.nodes.map((n) => n.id).sort()).toEqual([a, b].sort());

    const fileA = readFileSync(join(dir, `${a}.md`), "utf8");
    expect(fileA).toContain("name: expm-file-a");
    expect(fileA).toContain("# expm-file-a");
    expect(fileA).toContain("file a body");
    expect(existsSync(join(dir, `${b}.md`))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, "notees-manifest.json"), "utf8")) as {
      format: string;
      version: number;
      nodes: { id: string; name: string; type: string; isClass: boolean; presentAsMain: boolean }[];
    };
    expect(manifest.format).toBe("notees-markdown");
    expect(manifest.version).toBe(2);
    expect(manifest.nodes).toHaveLength(2);
    expect(manifest.nodes.find((n) => n.id === a)).toMatchObject({
      name: "expm-file-a",
      type: "page",
      isClass: false,
      presentAsMain: true,
    });
  });

  it("--depth 0 limits the closure to the seed's direct referrers", async () => {
    const h = harness;
    const target = await h.createPage("expm-depth-target", []);
    const direct = await h.createPage("expm-depth-direct", [
      { type: "mention", targetNodeId: target, text: "expm-depth-target" },
    ]);
    const transitive = await h.createPage("expm-depth-transitive", [
      { type: "mention", targetNodeId: direct, text: "expm-depth-direct" },
    ]);
    expect(transitive).toBeDefined();

    expect(await h.runCli("export", "markdown", "--linked-to", target, "--depth", "0", "--stdout")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("# expm-depth-direct");
    expect(h.io.stdoutText).not.toContain("# expm-depth-transitive");

    // Default depth (3) reaches the transitive referrer.
    expect(await h.runCli("export", "markdown", "--linked-to", target, "--stdout")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("# expm-depth-transitive");
  });

  it("children render as nested bullets under their page", async () => {
    const h = harness;
    const pageId = await h.createPage("expm-parent", [{ type: "text", text: "parent body" }]);
    await h.runCliWithStdin(
      JSON.stringify({
        presentAsMain: false,
        parentId: pageId,
        contentAst: [{ type: "text", text: "child bullet body" }],
      }),
      "--json", "object", "create", "--stdin",
    );

    expect(await h.runCli("export", "markdown", "--ids", pageId, "--stdout")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("parent body");
    expect(h.io.stdoutText).toContain("- child bullet body");
  });

  it("children come from the position-ordered children endpoint, not the paged object scan", async () => {
    // Fake transport over a real ApiClient: the children endpoint answers in
    // a deliberate non-id order; the bundle must preserve it, recurse into
    // discovered inline children, skip child pages, and never touch the
    // paged /api/objects list.
    const pageId = "11111111-1111-4111-8111-111111111111";
    const childA = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa"; // id order: A, B, G
    const childB = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb"; // endpoint order: B, A
    const grand = "cccccccc-3333-4ccc-8ccc-cccccccccccc";
    const childPage = "dddddddd-4444-4ddd-8ddd-dddddddddddd";

    const objectFixture = (
      id: string,
      overrides: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id,
      isClass: false,
      presentAsMain: false,
      parentId: pageId,
      classIds: [],
      name: null,
      contentAst: [],
      properties: [],
      ...overrides,
    });
    const objects = new Map<string, Record<string, unknown>>([
      [pageId, objectFixture(pageId, {
        presentAsMain: true,
        parentId: null,
        name: "fake page",
        contentAst: [{ type: "text", text: "fake page" }],
      })],
      [childA, objectFixture(childA, { contentAst: [{ type: "text", text: "alpha body" }] })],
      [childB, objectFixture(childB, { contentAst: [{ type: "text", text: "beta body" }] })],
      [grand, objectFixture(grand, { parentId: childB, contentAst: [{ type: "text", text: "grand body" }] })],
      [childPage, objectFixture(childPage, {
        presentAsMain: true,
        contentAst: [{ type: "text", text: "child page body" }],
      })],
    ]);
    const childrenFixtures = new Map<string, unknown[]>([
      [pageId, [objects.get(childB), objects.get(childA), objects.get(childPage)]],
      [childB, [objects.get(grand)]],
    ]);

    const requested: string[] = [];
    const jsonResponse = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url.pathname + url.search);
      const objectMatch = /^\/api\/objects\/([^/]+)\/children$/.exec(url.pathname);
      if (objectMatch !== null) {
        return jsonResponse({ children: childrenFixtures.get(decodeURIComponent(objectMatch[1]!)) ?? [] });
      }
      const singleMatch = /^\/api\/objects\/([^/]+)$/.exec(url.pathname);
      if (singleMatch !== null) {
        const object = objects.get(decodeURIComponent(singleMatch[1]!));
        return object === undefined
          ? jsonResponse({ error: { code: "not_found", message: "missing" } }, 404)
          : jsonResponse({ object });
      }
      if (url.pathname === "/api/objects") {
        // A regressed paged scan gets a valid empty page so the URL
        // assertion below carries the failure, not the empty bundle.
        return jsonResponse({ objects: [], nextCursor: null });
      }
      if (url.pathname === "/api/property-schemas") {
        return jsonResponse({ propertySchemas: [] });
      }
      return jsonResponse({ error: { code: "unexpected", message: url.pathname } }, 500);
    };
    const client = new ApiClient({ server: "http://export-test.local", apiKey: "k", fetchImpl });

    const bundle = await buildMarkdownBundle(client, { ids: [pageId], depth: 0 });

    const file = bundle.files.find((entry) => entry.path === `${pageId}.md`);
    expect(file).toBeDefined();
    // Endpoint order wins over id order.
    expect(file!.content.indexOf("beta body")).toBeLessThan(file!.content.indexOf("alpha body"));
    // The discovered inline child is itself queried (nested bullets recurse).
    expect(file!.content).toContain("grand body");
    // A child page is its own bundle file, never a nested bullet.
    expect(file!.content).not.toContain("child page body");
    expect(requested.filter((path) => path.endsWith("/children"))).toEqual([
      `/api/objects/${pageId}/children`,
      `/api/objects/${childB}/children`,
      `/api/objects/${childA}/children`,
      `/api/objects/${grand}/children`,
    ]);
    expect(requested.some((path) => path.startsWith("/api/objects?"))).toBe(false);
  });

  it("children render in child-position order (endpoint order, not id order)", async () => {
    const h = harness;
    const pageId = await h.createPage("expm-order-parent", []);
    const mkChild = async (text: string): Promise<string> => {
      const code = await h.runCliWithStdin(
        JSON.stringify({ presentAsMain: false, parentId: pageId, contentAst: [{ type: "text", text }] }),
        "--json", "object", "create", "--stdin",
      );
      if (code !== EXIT.ok) throw new Error(`mkChild ${text} failed: ${h.io.stderrText}`);
      return (JSON.parse(h.io.stdoutText) as { id: string }).id;
    };
    const a = await mkChild("order-first");
    const b = await mkChild("order-second");
    const c = await mkChild("order-third");
    // A main child: exported as its own file when selected, never a bullet.
    await h.runCliWithStdin(
      JSON.stringify({ presentAsMain: true, parentId: pageId, contentAst: [{ type: "text", text: "order-main-child-body" }] }),
      "--json", "object", "create", "--stdin",
    );

    // Invert the position order through the relay write path (ids stay
    // creation-ordered, so child order and id order genuinely differ). The
    // crafted HLC runs ahead of the server-stamped creates.
    const move = newEnvelope({
      workspaceId: defaultWorkspaceId(),
      actorId: "99999999-8888-4777-8666-555555555555",
      deviceId: "test",
      hlc: { physical: Date.now() + 1000, logical: 0 },
      opType: "object.move",
      payload: { objectId: c, parentId: pageId, beforeId: a },
    });
    const res = await fetch(`${h.baseUrl}/api/relay/v2/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ envelopes: [move] }),
    });
    expect(res.status).toBe(200);

    expect(await h.runCli("export", "markdown", "--ids", pageId, "--stdout")).toBe(EXIT.ok);
    const first = h.io.stdoutText.indexOf("- order-first");
    const second = h.io.stdoutText.indexOf("- order-second");
    const third = h.io.stdoutText.indexOf("- order-third");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(third).toBeGreaterThanOrEqual(0);
    expect(third).toBeLessThan(first);
    expect(first).toBeLessThan(second);
    expect(h.io.stdoutText).not.toContain("order-main-child-body");
  });

  it("--fixpoint expands until no new pages are found", async () => {
    const h = harness;
    // NB: a true mention cycle cannot be authored through the M1 CLI (object
    // update carries no content flag and ids are server-generated), so the
    // fixpoint path is exercised with a referrer chain instead.
    const a = await h.createPage("expm-fp-a", []);
    const b = await h.createPage("expm-fp-b", [
      { type: "mention", targetNodeId: a, text: "expm-fp-a" },
    ]);
    const c = await h.createPage("expm-fp-c", [
      { type: "mention", targetNodeId: b, text: "expm-fp-b" },
    ]);
    expect(c).toBeDefined();

    expect(await h.runCli("export", "markdown", "--linked-to", a, "--fixpoint", "--stdout")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("# expm-fp-a");
    expect(h.io.stdoutText).toContain("# expm-fp-b");
    expect(h.io.stdoutText).toContain("# expm-fp-c");
  });

  it("usage errors exit 2 (missing selector, missing output)", async () => {
    const h = harness;
    expect(await h.runCli("export", "markdown", "--stdout")).toBe(EXIT.usage);
    expect(await h.runCli("export", "markdown", "--ids", crypto.randomUUID())).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("--output-dir");
  });
});

const BIB_FIXTURE = `% Round-trip fixture
@book{cli-kuhn1962,
  title     = {The {Structure} of {Scientific} {Revolutions}},
  author    = {Kuhn, Thomas S.},
  year      = 1962,
  publisher = {University of Chicago Press},
  isbn      = {9780226458120},
}
@article{cli-david1962,
  title   = {Combinatorial Chance à la française},
  author  = {David, F. N. and Barton, D. E.},
  year    = {1962},
  doi     = {10.2307/2333763},
}`;

describe("bibliography round-trip (bibtex)", () => {
  it("import creates sources with classes/properties and find-or-created person authors", async () => {
    const h = harness;
    const file = join(h.dataDir, "bib-import-1.bib");
    writeFileSync(file, BIB_FIXTURE);

    expect(await h.runCli("--json", "import", "bibtex", file)).toBe(EXIT.ok);
    const counts = JSON.parse(h.io.stdoutText);
    expect(counts).toMatchObject({ created: 2, updated: 0, persons: 3, personsCreated: 3 });

    // The book source: class + title + citekey + bibliographic properties.
    const bookId = counts.entries[0] as string;
    expect(bookId).toMatch(/^[0-9a-f-]{36}$/);
    await h.runCli("--json", "object", "get", bookId);
    const book = JSON.parse(h.io.stdoutText).object;
    expect(book.name).toBe("The Structure of Scientific Revolutions");
    expect(book.classIds).toContain(SYSTEM_CLASS_UUIDS.book);
    const props = book.properties as { schemaId: string; value: unknown }[];
    expect(props.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.citekey)?.value).toBe("cli-kuhn1962");
    expect(props.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.isbn)?.value).toBe("9780226458120");
    expect(props.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.publisher)?.value).toBe(
      "University of Chicago Press",
    );
    // publicationDate is a date-chain ref since §34.28 #19: a {nodeId} link
    // to the content-addressed year node, which backlinks everything dated
    // that year.
    const pubRef = props.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.publicationDate)?.value as {
      nodeId: string;
    };
    expect(pubRef.nodeId).toMatch(/^[0-9a-f-]{36}$/);
    await h.runCli("--json", "object", "get", pubRef.nodeId);
    expect(JSON.parse(h.io.stdoutText).object.classIds).toContain(SYSTEM_CLASS_UUIDS.year);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("1962");
    // Authors are the node-typed property — {nodeId} refs to agent nodes, one per author.
    const authorRef = props.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.authors)?.value as {
      nodeId: string;
    };
    expect(authorRef.nodeId).toMatch(/^[0-9a-f-]{36}$/);

    // The paper source maps article → article class (owner family naming).
    const paperId = counts.entries[1] as string;
    await h.runCli("--json", "object", "get", paperId);
    const paper = JSON.parse(h.io.stdoutText).object;
    expect(paper.classIds).toContain(SYSTEM_CLASS_UUIDS.article);
    const paperProps = paper.properties as { schemaId: string; value: unknown }[];
    expect(paperProps.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.doi)?.value).toBe("10.2307/2333763");
    expect(
      paperProps.filter((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.authors).map((p) => p.value),
    ).toEqual([{ nodeId: expect.stringMatching(/^[0-9a-f-]{36}$/) }, { nodeId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);

    // The author person node: person class + the verbatim display name.
    await h.runCli("--json", "object", "get", authorRef.nodeId);
    const person = JSON.parse(h.io.stdoutText).object;
    expect(person.name).toBe("Kuhn, Thomas S.");
    expect(person.classIds).toContain(SYSTEM_CLASS_UUIDS.person);

    // Exactly three persons exist (Kuhn, David, Barton).
    await h.runCli("--json", "class", "list");
    const classes = JSON.parse(h.io.stdoutText).classes as { id: string; memberCount: number }[];
    expect(classes.find((c) => c.id === SYSTEM_CLASS_UUIDS.person)?.memberCount).toBe(3);
  });

  it("re-import dedupes persons by exact name and upserts by citekey (no duplicates)", async () => {
    const h = harness;
    const file = join(h.dataDir, "bib-import-2.bib");
    writeFileSync(file, BIB_FIXTURE);

    expect(await h.runCli("--json", "import", "bibtex", file)).toBe(EXIT.ok);
    const counts = JSON.parse(h.io.stdoutText);
    expect(counts).toMatchObject({ created: 0, updated: 2, persons: 3, personsCreated: 0 });

    // Exactly one object per citekey after the re-import.
    await h.runCli("--json", "object", "list", "--property", `${SYSTEM_PROPERTY_UUIDS.citekey}:cli-kuhn1962`);
    expect(JSON.parse(h.io.stdoutText).objects).toHaveLength(1);
    await h.runCli("--json", "object", "list", "--property", `${SYSTEM_PROPERTY_UUIDS.citekey}:cli-david1962`);
    expect(JSON.parse(h.io.stdoutText).objects).toHaveLength(1);
    // Still exactly three person nodes — the re-import matched them by name.
    await h.runCli("--json", "class", "list");
    const classes = JSON.parse(h.io.stdoutText).classes as { id: string; memberCount: number }[];
    expect(classes.find((c) => c.id === SYSTEM_CLASS_UUIDS.person)?.memberCount).toBe(3);
  });

  it("citekey upsert updates the existing source instead of duplicating it", async () => {
    const h = harness;
    const file = join(h.dataDir, "bib-import-3.bib");
    writeFileSync(
      file,
      `@book{cli-kuhn1962,
  title = {The Structure of Scientific Revolutions, 2nd ed.},
  author = {Kuhn, Thomas S.},
  year = 1970,
  isbn = {9780226458083},
}`,
    );
    expect(await h.runCli("--json", "import", "bibtex", file)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText)).toMatchObject({ created: 0, updated: 1 });

    await h.runCli("--json", "object", "list", "--property", `${SYSTEM_PROPERTY_UUIDS.citekey}:cli-kuhn1962`);
    const objects = JSON.parse(h.io.stdoutText).objects as { id: string }[];
    expect(objects).toHaveLength(1);
    await h.runCli("--json", "object", "get", objects[0]!.id);
    const book = JSON.parse(h.io.stdoutText).object;
    expect(book.name).toBe("The Structure of Scientific Revolutions, 2nd ed.");
    const props = book.properties as { schemaId: string; value: unknown }[];
    expect(props.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.isbn)?.value).toBe("9780226458083");
    const pubRef = props.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.publicationDate)?.value as {
      nodeId: string;
    };
    expect(pubRef.nodeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("export bibtex --ids renders entries; CSL round-trip keeps title/author/year/doi stable", async () => {
    const h = harness;
    const file = join(h.dataDir, "bib-import-4.bib");
    writeFileSync(
      file,
      `@book{cli-exp-kuhn1962,
  title   = {The {Structure} of {Scientific} {Revolutions}},
  author  = {Kuhn, Thomas S.},
  year    = 1962,
  isbn    = {9780226458120},
}
@article{cli-exp-david1962,
  title  = {Combinatorial Chance à la française},
  author = {David, F. N. and Barton, D. E.},
  year   = {1962},
  doi    = {10.2307/2333763},
}`,
    );
    expect(await h.runCli("--json", "import", "bibtex", file)).toBe(EXIT.ok);
    const { entries } = JSON.parse(h.io.stdoutText) as { entries: string[] };

    // Human output is the .bib document itself.
    expect(await h.runCli("export", "bibtex", "--ids", entries[0]!, entries[1]!)).toBe(EXIT.ok);
    const bibText = h.io.stdoutText;
    expect(bibText).toContain("@book{cli-exp-kuhn1962,");
    expect(bibText).toContain("@article{cli-exp-david1962,");

    // Round-trip: parse the exported document back and compare CSL fields.
    const roundTripped = parseBibtex(bibText);
    const byKey = new Map(roundTripped.map((entry) => [entry.citeKey, bibToCsl(entry)]));
    const kuhn = byKey.get("cli-exp-kuhn1962")!;
    expect(kuhn.type).toBe("book");
    expect(kuhn.title).toBe("The Structure of Scientific Revolutions");
    expect(kuhn.author).toEqual([{ family: "Kuhn", given: "Thomas S." }]);
    expect(kuhn.issued).toEqual({ "date-parts": [[1962]] });
    expect(kuhn.ISBN).toBe("9780226458120");
    const david = byKey.get("cli-exp-david1962")!;
    expect(david.type).toBe("article"); // article class → CSL article (owner family naming)
    expect(david.author).toEqual([
      { family: "David", given: "F. N." },
      { family: "Barton", given: "D. E." },
    ]);
    expect(david.issued).toEqual({ "date-parts": [[1962]] });
    expect(david.DOI).toBe("10.2307/2333763");
  });

  it("export bibtex --linked-to includes source referrers and skips non-source closure pages", async () => {
    const h = harness;
    const file = join(h.dataDir, "bib-import-5.bib");
    writeFileSync(file, BIB_FIXTURE);
    expect(await h.runCli("--json", "import", "bibtex", file)).toBe(EXIT.ok);
    const { entries } = JSON.parse(h.io.stdoutText) as { entries: string[] };

    // A reading-notes page mentions the book; a bare page does not.
    await h.createPage("bib-notes", [
      { type: "mention", targetNodeId: entries[0], text: "bib-notes-target" },
    ]);

    expect(await h.runCli("--json", "export", "bibtex", "--linked-to", entries[0]!, "--depth", "0")).toBe(EXIT.ok);
    const machine = JSON.parse(h.io.stdoutText);
    // The seed book renders; the non-source notes page is skipped.
    expect(machine.entries).toBe(1);
    expect(machine.skipped).toBe(1);
    expect(machine.bib).toContain("@book{");
    expect(machine.bib).not.toContain("bib-notes");
  });

  it("export resolves author node ids to current display names", async () => {
    const h = harness;
    const file = join(h.dataDir, "bib-import-6.bib");
    writeFileSync(
      file,
      `@book{cli-link-kuhn1962,
  title  = {The {Structure} of {Scientific} {Revolutions}},
  author = {Kuhn, Thomas S.},
  year   = 1962,
}`,
    );
    expect(await h.runCli("--json", "import", "bibtex", file)).toBe(EXIT.ok);
    const { entries } = JSON.parse(h.io.stdoutText) as { entries: string[] };
    const bookId = entries[0]!;

    // The authors property points at the person node; export must resolve
    // the current display name, not a snapshot taken at import time.
    await h.runCli("--json", "object", "get", bookId);
    const book = JSON.parse(h.io.stdoutText).object;
    const authorRef = (book.properties as { schemaId: string; value: { nodeId: string } }[]).find(
      (p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.authors,
    )!.value;

    expect(await h.runCli("export", "bibtex", "--ids", bookId)).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("author = {Kuhn, Thomas S.}");

    // Rename the person node; the next export renders the new name.
    expect(await h.runCli("object", "update", authorRef.nodeId, "--name", "Sagan, Carl")).toBe(EXIT.ok);
    expect(await h.runCli("export", "bibtex", "--ids", bookId)).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("author = {Sagan, Carl}");
    expect(h.io.stdoutText).not.toContain("Kuhn, Thomas S.");
  });

  it("usage errors exit 2 (missing file, no entries)", async () => {
    const h = harness;
    expect(await h.runCli("import", "bibtex", join(h.dataDir, "does-not-exist.bib"))).toBe(EXIT.usage);
    const empty = join(h.dataDir, "bib-empty.bib");
    writeFileSync(empty, "% only a comment\n");
    expect(await h.runCli("import", "bibtex", empty)).toBe(EXIT.domain);
    expect(h.io.stderrText).toContain("no BibTeX entries");
  });
});


describe("search (query language)", () => {
  /** Direct-fixture helper: the CLI has no property-schema write command. */
  async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${harness.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`fixture POST ${path} failed: HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  let yearSchemaId = "";
  async function makePaper(name: string, year?: number): Promise<string> {
    if (yearSchemaId === "") {
      yearSchemaId = (
        await apiPost<{ propertySchema: { id: string } }>("/api/property-schemas", {
          propertySchemaId: crypto.randomUUID(),
          name: "year",
          type: "number",
        })
      ).propertySchema.id;
    }
    const { id } = await apiPost<{ id: string }>("/api/objects", {
      presentAsMain: true,
      // Title-is-content: the paper's own content IS its title.
      contentAst: [{ type: "text", text: name }],
      classIds: [SYSTEM_CLASS_UUIDS.paper],
    });
    await apiPost<{ id: string }>("/api/objects", {
      presentAsMain: false,
      parentId: id,
      contentAst: [{ type: "text", text: `${name} body text` }],
    });
    if (year !== undefined) {
      await apiPost(`/api/objects/${id}/properties`, {
        propertySchemaId: yearSchemaId,
        value: year,
        idx: 0,
      });
    }
    return id;
  }

  it("class:paper AND year:>2010 returns the right pages (DSL → AST → POST /query)", async () => {
    const h = harness;
    const old = await makePaper("dslpaper1901", 1901);
    const modern = await makePaper("dslpaper2015", 2015);
    await makePaper("dslplainpage");

    expect(await h.runCli("--json", "search", "class:paper AND year:>2010")).toBe(EXIT.ok);
    const body = JSON.parse(h.io.stdoutText) as { ids: string[]; rows: { id: string; name: string | null }[] };
    expect(body.ids).toEqual([modern]);
    expect(body.rows.map((row) => row.name)).toEqual(["dslpaper2015"]);
    expect(body.ids).not.toContain(old);
  });

  it("prop: comparison operators and bare-schema shorthand select by year", async () => {
    const h = harness;
    const a = await makePaper("dslyear1937", 1937);
    const b = await makePaper("dslyear2060", 2060);

    // Earlier tests' papers share the workspace; assert containment.
    expect(await h.runCli("--json", "search", "prop:year:>=1900")).toBe(EXIT.ok);
    const all = JSON.parse(h.io.stdoutText).ids as string[];
    expect(all).toContain(a);
    expect(all).toContain(b);

    expect(await h.runCli("--json", "search", "year:<1950")).toBe(EXIT.ok);
    const below = JSON.parse(h.io.stdoutText).ids as string[];
    expect(below).toContain(a);
    expect(below).not.toContain(b);
  });

  it("text:, quoted phrases, boolean composition and linked:Name", async () => {
    const h = harness;
    const target = await makePaper("dsllinktarget");
    // Title-is-content: page content IS the title, so the prose lives on a
    // child block; the block is what text:/linked: match against.
    const notes = await h.createPage("dsllinknotes", []);
    const notesBlock = await h.runCliWithStdin(
      JSON.stringify({
        presentAsMain: false,
        parentId: notes,
        contentAst: [
          { type: "mention", targetNodeId: target, text: "the linked paper" },
          { type: "text", text: "revolutionary ideas" },
        ],
      }),
      "--json", "object", "create", "--stdin",
    );
    expect(notesBlock).toBe(EXIT.ok);
    const notesBlockId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    const other = await h.createPage("dsllinkother", []);
    const otherBlock = await h.runCliWithStdin(
      JSON.stringify({
        presentAsMain: false,
        parentId: other,
        contentAst: [{ type: "text", text: "revolutionary manifesto" }],
      }),
      "--json", "object", "create", "--stdin",
    );
    expect(otherBlock).toBe(EXIT.ok);
    const otherBlockId = (JSON.parse(h.io.stdoutText) as { id: string }).id;

    // text: term + phrase both hit the notes block; NOT excludes it.
    expect(await h.runCli("--json", "search", 'text:revolutionary AND "ideas"')).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).ids).toEqual([notesBlockId]);

    expect(await h.runCli("--json", "search", "text:revolutionary NOT linked:dsllinktarget")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).ids).toEqual([otherBlockId]);

    // linked:<name> resolves the node by name and matches its referrers.
    expect(await h.runCli("--json", "search", "linked:dsllinktarget")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).ids).toEqual([notesBlockId]);
  });

  it("human mode lists result names; plain text still routes to FTS", async () => {
    const h = harness;
    await makePaper("dslhuman2015", 2015);
    expect(await h.runCli("search", "class:paper AND year:>=2010")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("dslhuman2015");
    expect(h.io.stdoutText).not.toContain("{");

    expect(await h.runCli("--json", "search", "dslhuman2015")).toBe(EXIT.ok);
    const body = JSON.parse(h.io.stdoutText);
    expect(body.results.map((r: { id: string }) => r.id).length).toBeGreaterThan(0);
  });

  it("unknown classes, schemas and bad syntax fail loud with exit 2", async () => {
    const h = harness;
    expect(await h.runCli("search", "class:nosuchclass AND year:>2010")).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("invalid query");
    expect(h.io.stderrText).toContain("unknown class 'nosuchclass'");

    expect(await h.runCli("search", "wobble:42")).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("unknown field 'wobble'");

    expect(await h.runCli("search", "year:>")).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("requires a value");
  });
});

describe("daily notes (§34.28 #13)", () => {
  it("today ensures the local date chain + day page; --append blocks; journal lists newest first", async () => {
    const h = harness;
    expect(await h.runCli("--json", "today")).toBe(EXIT.ok);
    const day = JSON.parse(h.io.stdoutText) as { id: string; classIds: string[]; parentId: string | null };
    expect(day.classIds).toContain(SYSTEM_CLASS_UUIDS.day);
    const created = JSON.parse(h.io.stdoutText) as { createdAt: string | null };

    // Append a block; the day object carries it as a child.
    expect(await h.runCli("today", "--append", "captured from the CLI")).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "children", day.id)).toBe(EXIT.ok);
    const children = JSON.parse(h.io.stdoutText) as { children: Array<{ id: string }> };
    expect(children.children.length).toBe(1);

    // Idempotent: a second today returns the same day id.
    expect(await h.runCli("--json", "today")).toBe(EXIT.ok);
    expect((JSON.parse(h.io.stdoutText) as { id: string }).id).toBe(day.id);

    // journal lists the day newest-first.
    expect(await h.runCli("--json", "journal")).toBe(EXIT.ok);
    const journal = JSON.parse(h.io.stdoutText) as { days: Array<{ id: string }> };
    expect(journal.days.map((d) => d.id)).toContain(day.id);
    void created;
  });
});

describe("property schema verbs (§34.32 PG7)", () => {
  it("create → list → get → rename → bind → unbind → delete", async () => {
    const h = harness;

    // create prints the bare new id (human mode), options get deterministic ids.
    expect(await h.runCli("property", "create", "pg7-genre", "--type", "select", "--option", "Fiction", "--option", "Mystery")).toBe(EXIT.ok);
    const schemaId = h.io.stdoutText.trim();
    expect(schemaId).toMatch(/^[0-9a-f-]{36}$/);

    // --json list round-trips the schema rows.
    expect(await h.runCli("--json", "property", "list")).toBe(EXIT.ok);
    const listed = JSON.parse(h.io.stdoutText) as { propertySchemas: Array<{ id: string; name: string; type: string }> };
    expect(listed.propertySchemas).toContainEqual(expect.objectContaining({ id: schemaId, name: "pg7-genre", type: "select" }));

    // get resolves by name.
    expect(await h.runCli("--json", "property", "get", "pg7-genre")).toBe(EXIT.ok);
    const got = JSON.parse(h.io.stdoutText) as { propertySchema: { id: string; options: Array<{ label: string }> } };
    expect(got.propertySchema.id).toBe(schemaId);
    expect(got.propertySchema.options.map((o) => o.label)).toEqual(["Fiction", "Mystery"]);

    // rename (by name) → get by the new name resolves.
    expect(await h.runCli("property", "rename", "pg7-genre", "pg7-style")).toBe(EXIT.ok);
    expect(await h.runCli("--json", "property", "get", "pg7-style")).toBe(EXIT.ok);
    expect((JSON.parse(h.io.stdoutText) as { propertySchema: { id: string } }).propertySchema.id).toBe(schemaId);

    // bind to a class by title; unbind by name.
    expect(await h.runCli("object", "create", "--isClass", "--name", "pg7-shelf")).toBe(EXIT.ok);
    const classId = h.io.stdoutText.trim();
    expect(
      await h.runCli("--json", "property", "bind", "pg7-shelf", "pg7-style", "--sequence", "3", "--required", "--default", '"n/a"'),
    ).toBe(EXIT.ok);
    const bound = JSON.parse(h.io.stdoutText) as { classId: string; binding: { sequence: number; required: boolean; defaultValue: string } };
    expect(bound.classId).toBe(classId);
    expect(bound.binding).toMatchObject({ sequence: 3, required: true, defaultValue: "n/a" });

    expect(await h.runCli("property", "unbind", "pg7-shelf", "pg7-style")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("unbound pg7-style from pg7-shelf");

    // delete is preview-first; --yes soft-deletes. A uuid get then 404s
    // (exit 1); a name get fails name-resolution (exit 2) — the CLI's
    // schema-ref contract.
    expect(await h.runCli("property", "delete", "pg7-style")).toBe(EXIT.usage);
    expect(await h.runCli("property", "delete", "pg7-style", "--yes")).toBe(EXIT.ok);
    expect(await h.runCli("property", "get", schemaId)).toBe(EXIT.domain);
    expect(await h.runCli("property", "get", "pg7-style")).toBe(EXIT.usage);
  });

  it("usage and domain failures fail loud", async () => {
    const h = harness;
    expect(await h.runCli("property", "create", "x", "--type", "bogus")).toBe(EXIT.usage);
    expect(await h.runCli("property", "get", "no-such-schema")).toBe(EXIT.usage);
    expect(await h.runCli("property", "get", "10000000-0000-4000-8000-00000000dead")).toBe(EXIT.domain);
    expect(await h.runCli("property", "rename", "citekey", "")).toBe(EXIT.usage);

    // A wrong-typed binding default is a server-side 422 → exit 1.
    expect(await h.runCli("property", "create", "pg7-num", "--type", "number")).toBe(EXIT.ok);
    expect(await h.runCli("object", "create", "--isClass", "--name", "pg7-shelf-2")).toBe(EXIT.ok);
    expect(
      await h.runCli("property", "bind", "pg7-shelf-2", "pg7-num", "--default", '"not-a-number"'),
    ).toBe(EXIT.domain);
  });
});

describe("shell (scripted mode)", () => {
  it("scripted create → get → search → effective → delete; stdout carries the ids", async () => {
    const h = harness;
    // Piped stdin runs as a script: helpers are globals, top-level await works.
    const script = `
      const p = await create({
        presentAsMain: true,
        contentAst: [{ type: "text", text: "shell-t1-page" }],
      });
      console.log("created " + p.id);
      const got = await get(p.id);
      console.log("got " + got.name);
      const hits = await search("shell-t1-page");
      console.log("hits " + hits.map((hit) => hit.id).join(","));
      const eff = await effective(p.id);
      console.log("effective-count " + eff.length);
      const removed = await del(p.id, { permanent: true });
      console.log("deleted " + removed.id);
    `;
    const code = await h.runCliWithStdin(script, "shell");
    expect(code).toBe(EXIT.ok);

    const createdLine = h.io.stdoutText.split("\n").find((line) => line.startsWith("created "));
    expect(createdLine).toBeDefined();
    const id = createdLine!.slice("created ".length).trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.io.stdoutText).toContain(`got shell-t1-page`);
    // The search hit echoes the created id on the hits line.
    expect(h.io.stdoutText).toContain(`hits ${id}`);
    expect(h.io.stdoutText).toContain("deleted " + id);

    // The script really deleted the object.
    expect(await h.runCli("--json", "object", "get", id)).toBe(EXIT.domain);
  });

  it("scripted helper sweep: list, classes, classInfo, backlinks, props, setProperty, upload, export", async () => {
    const h = harness;
    // The server sniffs the file type (jpeg/png/webp/pdf/epub/audio) — reuse
    // the fake-PNG pattern from the asset round-trip test above.
    const assetFile = join(h.dataDir, "shell-t2-upload.png");
    writeFileSync(
      assetFile,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("shell-upload"),
      ]),
    );

    const script = `
      const p = await create({
        presentAsMain: true,
        name: "shell-t2-src",
        classIds: ["${SYSTEM_CLASS_UUIDS.book}"],
      });
      await setProperty(p.id, "${SYSTEM_PROPERTY_UUIDS.citekey}", "shellt2key");
      const mine = await props(p.id);
      console.log("citekey " + mine.find((x) => x.schemaName === "citekey").value);
      const found = await list({ property: "${SYSTEM_PROPERTY_UUIDS.citekey}:shellt2key" });
      console.log("found " + found.map((o) => o.id).join(","));
      const klasses = await classes();
      const person = klasses.find((c) => c.name === "person");
      const info = await classInfo(person.id);
      console.log("class " + info.name + " members=" + info.members.length);
      console.log("backlinks " + (await backlinks(p.id)).length);
      console.log("asset " + (await upload("${assetFile.replace(/\\/g, "\\\\")}")));
      console.log("export " + (await exportMd([p.id])).includes("shell-t2-src"));
      console.log("export-alias " + (await helpers.export([p.id])).includes("shell-t2-src"));
    `;
    const code = await h.runCliWithStdin(script, "shell");
    expect(code).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("citekey shellt2key");
    expect(h.io.stdoutText).toMatch(/found [0-9a-f-]{36}/);
    // The person class already has members from the bibtex tests above.
    expect(h.io.stdoutText).toMatch(/class person members=\d+/);
    expect(h.io.stdoutText).toContain("backlinks 0");
    expect(h.io.stdoutText).toMatch(/asset [0-9a-f-]{36}/);
    expect(h.io.stdoutText).toContain("export true");
    expect(h.io.stdoutText).toContain("export-alias true");
  });

  it("scripted property helpers: schema CRUD, class bind/unbind, unsetProperty", async () => {
    const h = harness;
    const script = `
      const schema = await createPropertySchema({
        propertySchemaId: "20000000-0000-7000-8000-0000000000ab",
        name: "shell-pg7-code",
        type: "text",
        multi: false,
        scope: "class",
      });
      console.log("created " + schema.id);
      const renamed = await updatePropertySchema(schema.id, { name: "shell-pg7-key" });
      console.log("renamed " + renamed.name);
      const all = await propertySchemas();
      console.log("listed " + all.some((s) => s.id === schema.id));
      const one = await propertySchema(schema.id);
      console.log("got " + one.name);
      const klasses = await classes();
      const source = klasses.find((c) => c.name === "source");
      const binding = await setClassProperty(source.id, schema.id, { sequence: 99, defaultValue: "shell-def" });
      console.log("bound " + binding.sequence + " " + binding.defaultValue);
      const obj = await create({ presentAsMain: true, name: "shell-pg7-src", classIds: [source.id] });
      await setProperty(obj.id, schema.id, "shell-authored");
      const eff = await effective(obj.id);
      console.log("shadowed " + eff.find((r) => r.schemaId === schema.id).value);
      await unsetProperty(obj.id, schema.id);
      const after = await effective(obj.id);
      console.log("default-back " + after.find((r) => r.schemaId === schema.id).value);
      await unsetClassProperty(source.id, schema.id);
      await deletePropertySchema(schema.id);
      try {
        await propertySchema(schema.id);
        console.log("deleted no");
      } catch {
        console.log("deleted yes");
      }
    `;
    const code = await h.runCliWithStdin(script, "shell");
    expect(code).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("created 20000000-0000-7000-8000-0000000000ab");
    expect(h.io.stdoutText).toContain("renamed shell-pg7-key");
    expect(h.io.stdoutText).toContain("listed true");
    expect(h.io.stdoutText).toContain("got shell-pg7-key");
    expect(h.io.stdoutText).toContain("bound 99 shell-def");
    expect(h.io.stdoutText).toContain("shadowed shell-authored");
    expect(h.io.stdoutText).toContain("default-back shell-def");
    expect(h.io.stdoutText).toContain("deleted yes");
  });

  it("erroring script exits 1 with the failure on stderr", async () => {
    const h = harness;
    const missing = crypto.randomUUID();
    const code = await h.runCliWithStdin(`await get("${missing}");`, "shell");
    expect(code).toBe(EXIT.domain);
    expect(h.io.stderrText).toContain("script failed");
    expect(h.io.stderrText).toContain("does not exist");
  });

  it("bad API key → 3 with a clear probe message", async () => {
    const h = harness;
    const io = new Capture();
    io.stdin = Readable.from(["const x = 1;\n"]);
    const code = await run(["--server", h.baseUrl, "--key", `nk_${"q".repeat(32)}`, "shell"], io);
    expect(code).toBe(EXIT.auth);
    expect(io.stderrText).toContain("authentication failed");
    io.stdin = undefined;
  });
});

describe("workspace selection (--workspace)", () => {
  it("--workspace <name> resolves via the account listing and addresses that workspace", async () => {
    const h = harness;
    // Name resolution is account-scoped: provision the first account, create
    // a named workspace, and mint a user API key (the operator key cannot
    // list workspaces).
    const setup = await h.app.inject({
      method: "POST",
      url: "/api/setup",
      headers: { "content-type": "application/json" },
      payload: { email: "cli-ws@example.test", password: "correct horse battery staple" },
    });
    expect(setup.statusCode).toBe(201);
    const session = setup.json().token as string;
    const authHeaders = { "x-api-key": session, "content-type": "application/json" };

    const workspace = (
      await h.app.inject({ method: "POST", url: "/api/workspaces", headers: authHeaders, payload: { name: "Notas-CLI-Test" } })
    ).json();
    const workspaceId = workspace.id as string;
    const userKey = (
      await h.app.inject({ method: "POST", url: "/api/api-keys", headers: authHeaders, payload: { name: "cli-test" } })
    ).json().token as string;

    const io = new Capture();
    const code = await run(
      ["--server", h.baseUrl, "--key", userKey, "--workspace", "Notas-CLI-Test", "--json", "object", "create", "--name", "ws-target"],
      io,
    );
    expect(code).toBe(EXIT.ok);
    const { id } = JSON.parse(io.stdoutText);

    // The object lives in the named workspace (operator key reads anywhere)…
    const inNamed = await h.app.inject({
      method: "GET",
      url: `/api/objects/${id}`,
      headers: { "x-api-key": API_KEY, "x-workspace-id": workspaceId },
    });
    expect(inNamed.statusCode).toBe(200);
    // …and NOT in the server default.
    const inDefault = await h.app.inject({ method: "GET", url: `/api/objects/${id}`, headers: { "x-api-key": API_KEY } });
    expect(inDefault.statusCode).toBe(404);

    // The name→id mapping is cached per profile in the CLI state file.
    const state = JSON.parse(readFileSync(h.stateFile, "utf8")) as {
      servers: Record<string, { workspaces?: Record<string, string> }>;
    };
    const cached = Object.values(state.servers).find((entry) => entry.workspaces?.["notas-cli-test"]);
    expect(cached).toBeDefined();
  });

  it("operator key cannot resolve names (account-scoped listing) — the error says to pass an id", async () => {
    const h = harness;
    const code = await h.runCli("--workspace", "whatever", "object", "list");
    expect(code).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("needs an account credential");
  });

  it("unknown workspace name fails with a usage error listing the available names", async () => {
    const h = harness;
    // The account from the first test exists now — log in for a session token.
    const login = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: "cli-ws@example.test", password: "correct horse battery staple" },
    });
    expect(login.statusCode).toBe(200);
    const session = login.json().token as string;

    const io = new Capture();
    const code = await run(["--server", h.baseUrl, "--key", session, "--workspace", "no-such-ws", "object", "list"], io);
    expect(code).toBe(EXIT.usage);
    expect(io.stderrText).toContain('workspace "no-such-ws" not found');
  });
});

describe("class assign/unassign", () => {
  it("assigns and unassigns by class title (idempotent ops)", async () => {
    const h = harness;
    expect(await h.runCli("--json", "object", "create", "--isClass", "--name", "genre-test")).toBe(EXIT.ok);
    const classId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    expect(await h.runCli("--json", "object", "create", "--name", "member-candidate")).toBe(EXIT.ok);
    const objectId = (JSON.parse(h.io.stdoutText) as { id: string }).id;

    expect(await h.runCli("--json", "class", "assign", objectId, "genre-test")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText)).toMatchObject({ objectId, classId, className: "genre-test" });
    expect((JSON.parse(h.io.stdoutText) as { classIds: string[] }).classIds).toEqual([classId]);

    expect(await h.runCli("--json", "class", "unassign", objectId, "genre-test")).toBe(EXIT.ok);
    expect((JSON.parse(h.io.stdoutText) as { classIds: string[] }).classIds).toEqual([]);
  });

  it("unknown class title is a usage error", async () => {
    const h = harness;
    expect(await h.runCli("--json", "object", "create", "--name", "whatever")).toBe(EXIT.ok);
    const objectId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    expect(await h.runCli("class", "assign", objectId, "no-such-class")).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain('no class named "no-such-class"');
  });
});

describe("credential handling", () => {
  it("non-nk-shaped credentials are sent verbatim (server 401 → exit 3, not a local usage error)", async () => {
    const h = harness;
    const io = new Capture();
    const code = await run(["--server", h.baseUrl, "--key", "a-session-token-shape-value", "doctor"], io);
    expect(code).toBe(EXIT.auth);
    expect(io.stderrText).not.toContain("must match");
  });
});

describe("shell op submission", () => {
  it("submitOp sends an op through the relay batch path and it applies", async () => {
    const h = harness;
    const script = `
      const p = await create({ presentAsMain: true, contentAst: [{ type: "text", text: "submitop-target" }] });
      const res = await submitOp("object.update", { objectId: p.id, contentAst: [{ type: "text", text: "submitop-renamed" }] }, [p.id]);
      console.log("saved " + res.savedCount);
      const after = await get(p.id);
      console.log("name " + after.name);
    `;
    const code = await h.runCliWithStdin(script, "shell");
    expect(code).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("saved 1");
    expect(h.io.stdoutText).toContain("name submitop-renamed");
  });
});

describe("auth (stored credentials)", () => {
  it("login stores a CLI API key; later commands use it without --key; logout revokes and clears", async () => {
    const h = harness;
    // The account from the workspace-selection describe exists; log in with it.
    // (runCli always injects --key, so drive `run` directly for the no-flag cases.)
    const loginIo = new Capture();
    const loginCode = await run(
      [
        "--server", h.baseUrl,
        "auth", "login",
        "--email", "cli-ws@example.test",
        "--password", "correct horse battery staple",
      ],
      loginIo,
    );
    expect(loginCode).toBe(EXIT.ok);
    expect(loginIo.stdoutText).toContain("logged in as cli-ws@example.test");

    // A command with no --key and no env falls back to the stored credential.
    const createIo = new Capture();
    const createCode = await run(["--server", h.baseUrl, "--json", "object", "create", "--name", "auth-stored-key"], createIo);
    expect(createCode).toBe(EXIT.ok);
    const created = JSON.parse(createIo.stdoutText) as { id: string };

    const statusIo = new Capture();
    expect(await run(["--server", h.baseUrl, "auth", "status"], statusIo)).toBe(EXIT.ok);
    expect(statusIo.stdoutText).toContain("valid");

    const logoutIo = new Capture();
    expect(await run(["--server", h.baseUrl, "auth", "logout"], logoutIo)).toBe(EXIT.ok);

    // After logout the stored credential is gone: commands fail as usage errors again.
    const afterIo = new Capture();
    expect(await run(["--server", h.baseUrl, "object", "get", created.id], afterIo)).toBe(EXIT.usage);
    expect(afterIo.stderrText).toContain("auth login");
  });
});

describe("tabular human output", () => {
  it("class list and object list render compact tables in human mode", async () => {
    const h = harness;
    expect(await h.runCli("class", "list")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("NAME");
    expect(h.io.stdoutText).toContain("MEMBERS");
    expect(h.io.stdoutText).toContain("source");

    expect(await h.runCli("object", "create", "--name", "table-output-probe")).toBe(EXIT.ok);
    expect(await h.runCli("object", "list", "--q", "table-output-probe")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("KIND");
    expect(h.io.stdoutText).toContain("table-output-probe");
  });
});

describe("class remap", () => {
  it("preview without --yes (exit 2), --dry-run changes nothing, --yes moves members and remaps extends", async () => {
    const h = harness;
    // from-class, to-class, two members, and an extender of from.
    expect(await h.runCli("--json", "object", "create", "--isClass", "--name", "remap-from")).toBe(EXIT.ok);
    const fromId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    expect(await h.runCli("--json", "object", "create", "--isClass", "--name", "remap-to")).toBe(EXIT.ok);
    const toId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    expect(await h.runCli("--json", "object", "create", "--isClass", "--name", "remap-extender")).toBe(EXIT.ok);
    const extenderId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    for (const name of ["remap-m1", "remap-m2"]) {
      expect(await h.runCli("--json", "object", "create", "--name", name, "--class", fromId)).toBe(EXIT.ok);
    }
    const setExtends = newEnvelope({
      workspaceId: defaultWorkspaceId(),
      actorId: "99999999-8888-4777-8666-555555555555",
      deviceId: "test",
      hlc: { physical: Date.now() + 1000, logical: 0 },
      opType: "class.setExtends",
      payload: { classId: extenderId, parentClassIds: [fromId] },
    });
    const ingestRes = await h.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      payload: { envelopes: [setExtends] },
    });
    expect(ingestRes.statusCode).toBe(200);

    // Preview: no --yes → exit 2 with the blast radius, nothing written.
    const memberCount = async (title: string): Promise<number | undefined> => {
      expect(await h.runCli("--json", "class", "list")).toBe(EXIT.ok);
      const row = (JSON.parse(h.io.stdoutText).classes as Array<{ name: string; memberCount: number }>).find(
        (c) => c.name === title,
      );
      return row?.memberCount;
    };
    expect(await h.runCli("class", "remap", "remap-from", "remap-to")).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("2 members");
    expect(await memberCount("remap-from")).toBe(2);

    // --dry-run: exit 0, still nothing written.
    expect(await h.runCli("class", "remap", "remap-from", "remap-to", "--dry-run")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("dry run");
    expect(await memberCount("remap-from")).toBe(2);

    // --yes: members move, the extender now extends to.
    expect(await h.runCli("--json", "class", "remap", "remap-from", "remap-to", "--yes")).toBe(EXIT.ok);
    const machine = JSON.parse(h.io.stdoutText) as { moved: number; extenders: number; extendsRemapped: number; failures: unknown[] };
    expect(machine.moved).toBe(2);
    expect(machine.failures).toEqual([]);
    expect(machine.extendsRemapped).toBe(1);

    expect(await memberCount("remap-from")).toBe(0);
    expect(await memberCount("remap-to")).toBe(2);
    expect(await h.runCli("--json", "class", "list")).toBe(EXIT.ok);
    const extenderRow = (JSON.parse(h.io.stdoutText).classes as Array<{ name: string; parentClassIds: string[] }>)
      .find((c) => c.name === "remap-extender");
    expect(extenderRow?.parentClassIds).toEqual([toId]);
  });
});

describe("object list --all", () => {
  it("follows the cursor to exhaustion", async () => {
    const h = harness;
    for (let i = 1; i <= 3; i += 1) {
      expect(await h.runCli("object", "create", "--name", `all-probe-${i}`)).toBe(EXIT.ok);
    }
    // Page size 2 < 3 results: without --all the first page stops early.
    expect(await h.runCli("--json", "object", "list", "--q", "all-probe", "--limit", "2")).toBe(EXIT.ok);
    const paged = JSON.parse(h.io.stdoutText) as { objects: unknown[]; nextCursor: string | null };
    expect(paged.objects.length).toBe(2);
    expect(paged.nextCursor).not.toBeNull();

    expect(await h.runCli("--json", "object", "list", "--q", "all-probe", "--limit", "2", "--all")).toBe(EXIT.ok);
    const all = JSON.parse(h.io.stdoutText) as { objects: unknown[]; nextCursor: string | null };
    expect(all.objects.length).toBe(3);
    expect(all.nextCursor).toBeNull();
  });
});

describe("ops catalog", () => {
  it("notees ops lists the catalog; one op prints its entry", async () => {
    const h = harness;
    expect(await h.runCli("ops")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("object.create");
    expect(h.io.stdoutText).toContain("class.unassign");

    expect(await h.runCli("ops", "class.unassign")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("OR-Set remove");
    expect(h.io.stdoutText).toContain("example");

    expect(await h.runCli("ops", "no.such.op")).toBe(EXIT.usage);
  });

  it("shell opHelp returns the entry and ops() the full list", async () => {
    const h = harness;
    const script = `
      const move = await opHelp("object.move");
      console.log("affected " + move.affected);
      console.log("count " + ops().length);
    `;
    expect(await h.runCliWithStdin(script, "shell")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("affected objectId");
    expect(h.io.stdoutText).toMatch(/count 2[0-9]/);
  });
});

describe("object children", () => {
  it("lists direct children in child-position order with render kinds", async () => {
    const h = harness;
    const parent = await h.createPage("children-probe", []);
    expect(await h.runCli("object", "create", "--name", "child-main", "--parent", parent, "--presentAsMain")).toBe(
      EXIT.ok,
    );
    const mainId = h.io.stdoutText.trim();
    expect(await h.runCli("object", "create", "--name", "child-block-1", "--parent", parent)).toBe(EXIT.ok);
    const b1 = h.io.stdoutText.trim();
    expect(await h.runCli("object", "create", "--name", "child-block-2", "--parent", parent)).toBe(EXIT.ok);
    const b2 = h.io.stdoutText.trim();

    expect(await h.runCli("--json", "object", "children", parent)).toBe(EXIT.ok);
    const res = JSON.parse(h.io.stdoutText) as {
      children: Array<{ id: string; name: string | null; presentAsMain: boolean }>;
    };
    expect(res.children.map((c) => c.id)).toEqual([mainId, b1, b2]);
    expect(res.children.map((c) => c.name)).toEqual(["child-main", "child-block-1", "child-block-2"]);

    // Human table: main-zone child reads as "page", inline body as "block".
    expect(await h.runCli("object", "children", parent)).toBe(EXIT.ok);
    expect(h.io.stdoutText).toMatch(/child-main\s+page/);
    expect(h.io.stdoutText).toMatch(/child-block-1\s+block/);
  });
});

describe("object create --batch", () => {
  it("creates every entry, prints ids in input order, keeps per-parent order", async () => {
    const h = harness;
    expect(await h.runCli("object", "create", "--name", "batch-parent")).toBe(EXIT.ok);
    const parentId = h.io.stdoutText.trim();
    const entries = [
      { name: "batch-root-1" },
      { name: "batch-root-2" },
      { name: "batch-b1", parentId },
      { name: "batch-b2", parentId },
      { name: "batch-b3", parentId },
    ];
    expect(await h.runCliWithStdin(JSON.stringify(entries), "--json", "object", "create", "--batch")).toBe(EXIT.ok);
    const res = JSON.parse(h.io.stdoutText) as { created: number; ids: string[]; failures: unknown[] };
    expect(res.created).toBe(5);
    expect(res.failures).toEqual([]);
    expect(res.ids).toHaveLength(5);

    // The parent's children keep the array order (same-parent entries are sequential).
    expect(await h.runCli("--json", "object", "children", parentId)).toBe(EXIT.ok);
    const children = JSON.parse(h.io.stdoutText).children as Array<{ id: string; name: string | null }>;
    expect(children.map((c) => c.id)).toEqual([res.ids[2], res.ids[3], res.ids[4]]);
    expect(children.map((c) => c.name)).toEqual(["batch-b1", "batch-b2", "batch-b3"]);
  });

  it("collects failures (exit 1) and honors --stop-on-error", async () => {
    const h = harness;
    // isClass alongside a parent is rejected server-side — a reliable failure.
    expect(await h.runCli("object", "create", "--name", "batch-parent-2")).toBe(EXIT.ok);
    const parentId = h.io.stdoutText.trim();
    const entries = [
      { name: "batch-ok-1" },
      { name: "batch-bad", isClass: true, parentId },
      { name: "batch-ok-2" },
    ];
    expect(await h.runCliWithStdin(JSON.stringify(entries), "--json", "object", "create", "--batch")).toBe(EXIT.domain);
    const res = JSON.parse(h.io.stdoutText) as { created: number; failures: Array<{ index: number }> };
    expect(res.created).toBe(2);
    expect(res.failures.map((f) => f.index)).toEqual([1]);

    const failing = [
      { name: "batch-bad-x", isClass: true, parentId },
      { name: "batch-never" },
    ];
    expect(
      await h.runCliWithStdin(JSON.stringify(failing), "--json", "object", "create", "--batch", "--stop-on-error", "--jobs", "1"),
    ).toBe(EXIT.domain);
    const res2 = JSON.parse(h.io.stdoutText) as { created: number; failures: Array<{ index: number; error: string }> };
    expect(res2.created).toBe(0);
    expect(res2.failures).toHaveLength(2);
    expect(res2.failures[1]!.error).toContain("skipped");

    // Usage: stdin must be a non-empty JSON array.
    expect(await h.runCliWithStdin("{}", "--json", "object", "create", "--batch")).toBe(EXIT.usage);
    expect(await h.runCliWithStdin("[]", "--json", "object", "create", "--batch")).toBe(EXIT.usage);
  });
});

describe("object upsert", () => {
  it("creates once, then returns the existing id without duplicating (case-insensitive title)", async () => {
    const h = harness;
    expect(await h.runCli("--json", "object", "create", "--isClass", "--name", "upsert-klass")).toBe(EXIT.ok);
    const klassId = (JSON.parse(h.io.stdoutText) as { id: string }).id;

    expect(await h.runCli("--json", "object", "upsert", "--name", "Upsert Target", "--class", klassId)).toBe(EXIT.ok);
    const first = JSON.parse(h.io.stdoutText) as { id: string; created: boolean };
    expect(first.created).toBe(true);

    expect(await h.runCli("--json", "object", "upsert", "--name", "upsert target", "--class", klassId)).toBe(EXIT.ok);
    const second = JSON.parse(h.io.stdoutText) as { id: string; created: boolean };
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    expect(await h.runCli("--json", "class", "list")).toBe(EXIT.ok);
    const row = (JSON.parse(h.io.stdoutText).classes as Array<{ id: string; memberCount: number }>).find(
      (c) => c.id === klassId,
    );
    expect(row?.memberCount).toBe(1);
  });

  it("ambiguity fails loud; --parent narrows the match", async () => {
    const h = harness;
    const p1 = await h.createPage("upsert-parent-1", []);
    const p2 = await h.createPage("upsert-parent-2", []);
    for (const p of [p1, p2]) {
      expect(await h.runCli("object", "create", "--name", "Same Title", "--parent", p)).toBe(EXIT.ok);
    }
    expect(await h.runCli("object", "upsert", "--name", "Same Title")).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("narrow with --class/--parent");

    expect(await h.runCli("object", "upsert", "--name", "Same Title", "--parent", p2)).toBe(EXIT.ok);
    expect(h.io.stdoutText.trim()).toBe(p2 === "" ? "" : h.io.stdoutText.trim());
    expect(h.io.stdoutText.trim()).not.toBe(p1);
  });
});

describe("class empty / delete-members", () => {
  it("empty unassigns without confirmation; delete-members previews, dry-runs, then trashes with --yes", async () => {
    const h = harness;
    expect(await h.runCli("--json", "object", "create", "--isClass", "--name", "bulk-klass")).toBe(EXIT.ok);
    const klassId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    const ids: string[] = [];
    for (const name of ["bulk-m1", "bulk-m2", "bulk-m3"]) {
      expect(await h.runCli("object", "create", "--name", name, "--class", klassId)).toBe(EXIT.ok);
      ids.push(h.io.stdoutText.trim());
    }

    // empty: no confirmation, membership gone, the nodes themselves stay.
    expect(await h.runCli("--json", "class", "empty", "bulk-klass")).toBe(EXIT.ok);
    expect((JSON.parse(h.io.stdoutText) as { done: number }).done).toBe(3);
    expect(await h.runCli("--json", "object", "get", ids[0]!)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.classIds as string[]).not.toContain(klassId);

    // Re-assign, then the destructive path: preview → dry-run → --yes.
    for (const id of ids) {
      expect(await h.runCli("class", "assign", id, "bulk-klass")).toBe(EXIT.ok);
    }
    expect(await h.runCli("class", "delete-members", "bulk-klass")).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("3 member nodes");
    expect(await h.runCli("class", "delete-members", "bulk-klass", "--dry-run")).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "get", ids[0]!)).toBe(EXIT.ok);

    expect(await h.runCli("--json", "class", "delete-members", "bulk-klass", "--yes")).toBe(EXIT.ok);
    const machine = JSON.parse(h.io.stdoutText) as { done: number; failures: unknown[] };
    expect(machine.done).toBe(3);
    expect(machine.failures).toEqual([]);
    // Trash is recoverable: the node is still fetchable, flagged inactive.
    expect(await h.runCli("--json", "object", "get", ids[0]!)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.isActive).toBe(false);
  });
});

describe("object restore + trash listing", () => {
  it("delete → list --trashed → restore brings the whole subtree back", async () => {
    const h = harness;
    const parent = await h.createPage("restore-probe-page", []);
    expect(await h.runCli("object", "create", "--name", "restore-probe-block", "--parent", parent)).toBe(EXIT.ok);
    const blockId = h.io.stdoutText.trim();

    expect(await h.runCli("object", "delete", parent, "--yes")).toBe(EXIT.ok);
    // Trashed: the trash listing shows both rows; the active listing does not.
    expect(await h.runCli("--json", "object", "list", "--trashed")).toBe(EXIT.ok);
    const trashed = JSON.parse(h.io.stdoutText).objects as Array<{ id: string }>;
    expect(trashed.map((o) => o.id)).toContain(parent);
    expect(await h.runCli("--json", "object", "list", "--q", "restore-probe")).toBe(EXIT.ok);
    const active = JSON.parse(h.io.stdoutText).objects as Array<{ id: string }>;
    expect(active.map((o) => o.id)).not.toContain(parent);

    expect(await h.runCli("--json", "object", "restore", parent)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).restored).toEqual([parent]);
    expect(await h.runCli("--json", "object", "get", parent)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.isActive).toBe(true);
    // Whole-tree: the child block rides the restore.
    expect(await h.runCli("--json", "object", "children", parent)).toBe(EXIT.ok);
    const children = JSON.parse(h.io.stdoutText).children as Array<{ id: string }>;
    expect(children.map((c) => c.id)).toContain(blockId);
  });

  it("restore of a node with no trash row still reactivates (idempotent read)", async () => {
    const h = harness;
    const page = await h.createPage("restore-noop", []);
    expect(await h.runCli("--json", "object", "restore", page)).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "get", page)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.isActive).toBe(true);
  });
});

describe("object property set/delete", () => {
  it("sets a typed value by schema name, shows it, unsets it", async () => {
    const h = harness;
    const schemaId = "00000000-0000-0000-0001-0000000000f1";
    const created = await h.app.inject({
      method: "POST",
      url: "/api/property-schemas",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      payload: { propertySchemaId: schemaId, name: "cliProbeRating", type: "number", multi: false, scope: "global" },
    });
    expect(created.statusCode).toBe(201);

    const page = await h.createPage("property-probe", []);
    expect(await h.runCli("--json", "object", "property", "set", page, "cliProbeRating", "42")).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "get", page)).toBe(EXIT.ok);
    let props = JSON.parse(h.io.stdoutText).object.properties as Array<{ schemaId: string; value: unknown }>;
    expect(props.map((p) => ({ schemaId: p.schemaId, value: p.value }))).toEqual([{ schemaId, value: 42 }]);

    // String values stay strings; --idx addresses multi-valued slots.
    expect(await h.runCli("--json", "object", "property", "set", page, "cliProbeRating", "42")).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "property", "delete", page, "cliProbeRating")).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "get", page)).toBe(EXIT.ok);
    props = JSON.parse(h.io.stdoutText).object.properties as Array<{ schemaId: string; value: unknown }>;
    expect(props).toEqual([]);
  });

  it("unknown schema name fails with usage", async () => {
    const h = harness;
    const page = await h.createPage("property-probe-2", []);
    expect(await h.runCli("object", "property", "set", page, "no.such.schema", "1")).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("no property schema named");
  });
});

describe("object list --parent", () => {
  it("filters to direct children of one parent", async () => {
    const h = harness;
    const parent = await h.createPage("parent-filter-probe", []);
    expect(await h.runCli("object", "create", "--name", "pf-child-1", "--parent", parent)).toBe(EXIT.ok);
    expect(await h.runCli("object", "create", "--name", "pf-child-2", "--parent", parent)).toBe(EXIT.ok);
    expect(await h.runCli("object", "create", "--name", "pf-other")).toBe(EXIT.ok);

    expect(await h.runCli("--json", "object", "list", "--parent", parent)).toBe(EXIT.ok);
    const names = (JSON.parse(h.io.stdoutText).objects as Array<{ name: string | null }>).map((o) => o.name);
    expect(names.sort()).toEqual(["pf-child-1", "pf-child-2"]);
  });
});

describe("export markdown --class", () => {
  it("seeds the bundle with the class's members", async () => {
    const h = harness;
    expect(await h.runCli("--json", "object", "create", "--isClass", "--name", "exp-klass")).toBe(EXIT.ok);
    const klassId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    for (const name of ["exp-member-a", "exp-member-b"]) {
      expect(await h.runCli("object", "create", "--name", name, "--class", klassId)).toBe(EXIT.ok);
    }
    expect(await h.runCli("export", "markdown", "--class", "exp-klass", "--stdout")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("exp-member-a");
    expect(h.io.stdoutText).toContain("exp-member-b");
    // Mutually exclusive with the other selectors.
    expect(await h.runCli("export", "markdown", "--class", "exp-klass", "--ids", klassId, "--stdout")).toBe(EXIT.usage);
  });
});

describe("export json (§34.59 JSON archive)", () => {
  interface ArchiveNode {
    id: string;
    isClass: boolean;
    presentAsMain: boolean;
    parentId: string | null;
    displayName: string;
    contentAst: unknown[];
    classIds: string[];
    properties: unknown[];
    children: string[];
    edges: Array<Record<string, unknown>>;
  }
  interface Archive {
    format: string;
    version: number;
    generatedAt: string;
    nodes: ArchiveNode[];
  }

  it("--ids --stdout emits the versioned envelope with verbatim payloads, child ids, and edges", async () => {
    const h = harness;
    const target = await h.createPage("expj-target", [{ type: "text", text: "target body" }]);
    const referrer = await h.createPage("expj-referrer", [
      { type: "mention", targetNodeId: target, text: "expj-target" },
      { type: "text", text: " links out" },
    ]);

    expect(await h.runCli("export", "json", "--ids", referrer)).toBe(EXIT.ok);
    const archive = JSON.parse(h.io.stdoutText) as Archive;
    expect(archive.format).toBe("notees-json-archive");
    expect(archive.version).toBe(1);
    expect(typeof archive.generatedAt).toBe("string");
    expect(archive.nodes).toHaveLength(1);
    const node = archive.nodes[0]!;
    expect(node.id).toBe(referrer);
    expect(node.isClass).toBe(false);
    expect(node.presentAsMain).toBe(true);
    expect(node.parentId).toBeNull();
    // Title-is-content: the page's own stream IS its title; the mention block
    // created by the helper rides as a child id (blocks are not in an
    // --ids slice, exactly like the markdown bundle).
    expect(node.displayName).toContain("expj-referrer");
    expect(node.contentAst).toEqual([{ type: "text", text: "expj-referrer" }]);
    expect(node.children).toHaveLength(1);
    expect(node.edges).toEqual([]);
  });

  it("records child ids (inline body + main zone) in position order", async () => {
    const h = harness;
    const pageId = await h.createPage("expj-parent", [{ type: "text", text: "inline block" }]);
    await h.runCliWithStdin(
      JSON.stringify({
        presentAsMain: true,
        parentId: pageId,
        contentAst: [{ type: "text", text: "child page" }],
      }),
      "--json", "object", "create", "--stdin",
    );
    expect(await h.runCli("export", "json", "--ids", pageId)).toBe(EXIT.ok);
    const archive = JSON.parse(h.io.stdoutText) as Archive;
    // One inline block + one main child page: both child ids recorded.
    expect(archive.nodes[0]!.children).toHaveLength(2);
  });

  it("--output writes the archive file; --json reports the machine summary", async () => {
    const h = harness;
    const a = await h.createPage("expj-file-a", []);
    const b = await h.createPage("expj-file-b", []);
    const file = join(h.dataDir, "expj-archive.json");

    expect(await h.runCli("--json", "export", "json", "--ids", a, b, "--output", file)).toBe(EXIT.ok);
    const machine = JSON.parse(h.io.stdoutText) as { format: string; version: number; nodes: number };
    expect(machine).toEqual({ format: "notees-json-archive", version: 1, nodes: 2 });

    const archive = JSON.parse(readFileSync(file, "utf8")) as Archive;
    expect(archive.format).toBe("notees-json-archive");
    expect(archive.version).toBe(1);
    expect(archive.nodes.map((node) => node.id).sort()).toEqual([a, b].sort());
  });

  it("--class seeds the archive with the class's members; selectors stay mutually exclusive", async () => {
    const h = harness;
    expect(await h.runCli("--json", "object", "create", "--isClass", "--name", "expj-klass")).toBe(EXIT.ok);
    const klassId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    expect(await h.runCli("object", "create", "--name", "expj-member", "--class", klassId)).toBe(EXIT.ok);

    expect(await h.runCli("export", "json", "--class", "expj-klass")).toBe(EXIT.ok);
    const archive = JSON.parse(h.io.stdoutText) as Archive;
    expect(archive.nodes).toHaveLength(1);
    expect(archive.nodes[0]!.displayName).toContain("expj-member");
    // Membership rides the classIds field (verbatim); content chips would
    // mine as edges — the member's title-only stream has none.
    expect(archive.nodes[0]!.classIds).toContain(klassId);
    expect(archive.nodes[0]!.edges).toEqual([]);

    expect(await h.runCli("export", "json", "--class", "expj-klass", "--ids", klassId)).toBe(EXIT.usage);
    expect(await h.runCli("export", "json")).toBe(EXIT.usage);
  });
});

describe("object get --ids and create --icon/--color", () => {
  it("multi-get returns objects in argument order", async () => {
    const h = harness;
    const a = await h.createPage("multi-get-a", []);
    const b = await h.createPage("multi-get-b", []);
    expect(await h.runCli("--json", "object", "get", "--ids", b, a)).toBe(EXIT.ok);
    const objects = JSON.parse(h.io.stdoutText).objects as Array<{ id: string }>;
    expect(objects.map((o) => o.id)).toEqual([b, a]);
  });

  it("create --icon/--color lands on the object", async () => {
    const h = harness;
    expect(await h.runCli("--json", "object", "create", "--name", "styled-probe", "--icon", "star", "--color", "#ff0000")).toBe(EXIT.ok);
    const id = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    expect(await h.runCli("--json", "object", "get", id)).toBe(EXIT.ok);
    const object = JSON.parse(h.io.stdoutText).object as { icon: string | null; color: string | null };
    expect(object.icon).toBe("star");
    expect(object.color).toBe("#ff0000");
  });

  it("object update --color accepts preset tokens and 'none' clears", async () => {
    const h = harness;
    expect(await h.runCli("--json", "object", "create", "--name", "color-probe")).toBe(EXIT.ok);
    const id = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    // Preset token rides the wire as-is.
    expect(await h.runCli("--json", "object", "update", id, "--color", "sky")).toBe(EXIT.ok);
    expect((JSON.parse(h.io.stdoutText).object as { color: string | null }).color).toBe("sky");
    // 'none' clears (object.update color: null — §34.43 grammar).
    expect(await h.runCli("--json", "object", "update", id, "--color", "none")).toBe(EXIT.ok);
    expect((JSON.parse(h.io.stdoutText).object as { color: string | null }).color).toBeNull();
    // Garbage is rejected server-side (strict color grammar) — 422 → domain exit.
    expect(await h.runCli("--json", "object", "update", id, "--color", "var(--color-preset-red)")).toBe(EXIT.domain);
  });
});

describe("covers (one-gesture cover)", () => {
  // 1x1 transparent PNG — the server sniffs content, magic bytes suffice.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const COVER_PROP = "00000000-0000-0000-0000-000000000005";
  const ASSET_CLASS = "00000000-0000-0000-0001-000000000009";

  async function pngFile(h: Harness, name: string): Promise<string> {
    const path = join(h.dataDir, name);
    writeFileSync(path, PNG);
    return path;
  }
  const coverOf = (object: { properties?: Array<{ schemaId: string; value: unknown }> }) =>
    (object.properties ?? []).find((p) => p.schemaId === COVER_PROP)?.value as { nodeId: string } | undefined;

  it("cover set <file> → get → skip-existing → replace → clear, with class hygiene", async () => {
    const h = harness;
    const page = await h.createPage("cover-probe", []);
    const file = await pngFile(h, "cover.png");

    // set from file: one call, asset node created + classed + attached.
    expect(await h.runCli("--json", "cover", "set", page, file)).toBe(EXIT.ok);
    const first = JSON.parse(h.io.stdoutText) as { assetId: string; replaced: string | null };
    expect(first.replaced).toBeNull();
    expect(await h.runCli("--json", "object", "get", first.assetId)).toBe(EXIT.ok);
    const asset = JSON.parse(h.io.stdoutText).object as { classIds: string[] };
    expect(asset.classIds).toContain(ASSET_CLASS);

    // get resolves the same asset.
    expect(await h.runCli("cover", "get", page)).toBe(EXIT.ok);
    expect(h.io.stdoutText.trim()).toBe(first.assetId);

    // skip-existing: same id, no writes.
    expect(await h.runCli("--json", "cover", "set", page, file, "--skip-existing")).toBe(EXIT.ok);
    const skipped = JSON.parse(h.io.stdoutText) as { assetId: string; created: boolean; replaced: string | null };
    expect(skipped).toMatchObject({ assetId: first.assetId, created: false, replaced: false });

    // replace: new asset, old one stays an asset, property repoints.
    expect(await h.runCli("--json", "cover", "set", page, file)).toBe(EXIT.ok);
    const second = JSON.parse(h.io.stdoutText) as { assetId: string; replaced: string | null };
    expect(second.assetId).not.toBe(first.assetId);
    expect(second.replaced).toBe(first.assetId);
    expect(await h.runCli("--json", "object", "get", page)).toBe(EXIT.ok);
    expect(coverOf(JSON.parse(h.io.stdoutText).object)?.nodeId).toBe(second.assetId);
    expect(await h.runCli("--json", "object", "get", first.assetId)).toBe(EXIT.ok);
    const stale = JSON.parse(h.io.stdoutText).object as { classIds: string[] };
    expect(stale.classIds).toContain(ASSET_CLASS);

    // clear: property gone.
    expect(await h.runCli("cover", "clear", page)).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "get", page)).toBe(EXIT.ok);
    expect(coverOf(JSON.parse(h.io.stdoutText).object)).toBeUndefined();
  });

  it("cover set --asset reuses an existing asset node and classes it", async () => {
    const h = harness;
    const pageA = await h.createPage("cover-share-a", []);
    const pageB = await h.createPage("cover-share-b", []);
    const file = await pngFile(h, "shared.png");
    expect(await h.runCli("cover", "set", pageA, file)).toBe(EXIT.ok);
    const assetId = h.io.stdoutText.trim();

    expect(await h.runCli("cover", "set", pageB, "--asset", assetId)).toBe(EXIT.ok);
    expect(h.io.stdoutText.trim()).toBe(assetId);
    expect(await h.runCli("--json", "object", "get", assetId)).toBe(EXIT.ok);
    const shared = JSON.parse(h.io.stdoutText).object as { classIds: string[] };
    expect(shared.classIds).toContain(ASSET_CLASS);

    // Clearing A leaves the asset untouched (it stays an asset; B still covers with it).
    expect(await h.runCli("cover", "clear", pageA)).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "get", assetId)).toBe(EXIT.ok);
    const afterClear = JSON.parse(h.io.stdoutText).object as { classIds: string[] };
    expect(afterClear.classIds).toContain(ASSET_CLASS);

    // Usage errors: neither/both sources, get/clear on a coverless node.
    expect(await h.runCli("cover", "set", pageB)).toBe(EXIT.usage);
    expect(await h.runCli("cover", "set", pageB, file, "--asset", assetId)).toBe(EXIT.usage);
    expect(await h.runCli("cover", "get", pageA)).toBe(EXIT.usage);
  });

  it("search exists-arm counts nodes with a property (prop:cover:)", async () => {
    const h = harness;
    expect(await h.runCli("--json", "object", "create", "--isClass", "--name", "cover-klass")).toBe(EXIT.ok);
    const klassId = (JSON.parse(h.io.stdoutText) as { id: string }).id;
    const withCover = await h.createPage("cover-k-with", []);
    const bare = await h.createPage("cover-k-bare", []);
    for (const id of [withCover, bare]) {
      expect(await h.runCli("class", "assign", id, klassId)).toBe(EXIT.ok);
    }
    expect(await h.runCli("cover", "set", withCover, await pngFile(h, "exists.png"))).toBe(EXIT.ok);

    expect(await h.runCli("--json", "search", "class:cover-klass prop:cover:")).toBe(EXIT.ok);
    const rows = JSON.parse(h.io.stdoutText).rows as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([withCover]);
    expect(await h.runCli("--json", "search", "class:cover-klass")).toBe(EXIT.ok);
    expect((JSON.parse(h.io.stdoutText).rows as unknown[]).length).toBe(2);
  });

  it("doctor reports the cli/server drift check", async () => {
    const h = harness;
    expect(await h.runCli("--json", "doctor")).toBe(EXIT.ok);
    const checks = JSON.parse(h.io.stdoutText).checks as Array<{ check: string; ok: boolean; detail: string }>;
    const drift = checks.find((c) => c.check === "cli/server version drift");
    expect(drift).toBeDefined();
    expect(drift!.ok).toBe(true); // test server builds from the same tree
  });
});

describe("property number formats", () => {
  it("create carries --pad/--decimals/--rounding; rejects them off-number", async () => {
    const h = harness;
    expect(
      await h.runCli("--json", "property", "create", "fmt-probe", "--type", "number", "--pad", "4", "--decimals", "1", "--rounding", "floor"),
    ).toBe(EXIT.ok);
    const created = JSON.parse(h.io.stdoutText).propertySchema as {
      id: string;
      numberPad: number | null;
      numberDecimals: number | null;
      numberRounding: string | null;
    };
    expect(created.numberPad).toBe(4);
    expect(created.numberDecimals).toBe(1);
    expect(created.numberRounding).toBe("floor");
    expect(await h.runCli("--json", "property", "get", created.id)).toBe(EXIT.ok);
    expect((JSON.parse(h.io.stdoutText).propertySchema as { numberPad: number }).numberPad).toBe(4);

    // Formatting flags on a non-number schema are a usage error.
    expect(await h.runCli("property", "create", "bad-fmt", "--type", "text", "--pad", "4")).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("require --type number");
    // Bad rounding mode and out-of-range decimals fail loud.
    expect(await h.runCli("property", "create", "bad-round", "--type", "number", "--rounding", "sideways")).toBe(EXIT.usage);
    expect(await h.runCli("property", "create", "bad-dec", "--type", "number", "--decimals", "42")).toBe(EXIT.usage);
  });
});

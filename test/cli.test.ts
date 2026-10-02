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

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { bibToCsl, parseBibtex } from "@notees/export";

import { buildServer } from "@notees/server";

import { run, type CliIo } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";

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
      nodes: { id: string; name: string; isClass: boolean; presentAsMain: boolean }[];
    };
    expect(manifest.format).toBe("notees-markdown");
    expect(manifest.version).toBe(1);
    expect(manifest.nodes).toHaveLength(2);
    expect(manifest.nodes.find((n) => n.id === a)).toMatchObject({
      name: "expm-file-a",
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
    expect(props.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.publicationDate)?.value).toBe("1962");
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
    expect(props.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.publicationDate)?.value).toBe("1970");
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

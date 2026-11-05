import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Clock, newEnvelope, type Envelope } from "@notees/protocol";

import { run, type CliIo } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";
import { DEFAULT_WORKSPACE_ID } from "../src/uuid.js";

import { FakeRelay } from "./fake-relay.js";

// Unit specs for the tag surface over the plan-07 local-first architecture:
// the CLI syncs the workspace through the relay wire protocol into a local
// derived store (test/fake-relay.ts implements that wire over an in-memory
// envelope log), the title resolution and the assign/unassign reads run
// against the local store, and the writes ride the outbox as envelopes. Graph
// state is seeded by appending envelopes to the fake relay's log — every CLI
// run syncs first, so the command under test sees the seed.

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

const OBJECT_ID = "11111111-1111-7111-8111-111111111111";
const TAG_ID = "22222222-2222-7222-8222-222222222222";
const TAG2_ID = "33333333-3333-7333-8333-333333333333";
const BASE = "http://notees-mock.test";
// The CLI addresses the server-default workspace when --workspace is absent;
// seeds must ride the same workspace id or the local read filters ignore them.
const WORKSPACE_ID = DEFAULT_WORKSPACE_ID;

const relay = new FakeRelay();
let stateDir = "";

const clock = new Clock("tag-test");
/** A stamped envelope for the fake relay's log (the seed path). */
function stamp(opType: string, payload: Record<string, unknown>, affected: string[] = []): Envelope {
  return newEnvelope({
    workspaceId: WORKSPACE_ID,
    actorId: "99999999-8888-4777-8666-555555555555",
    deviceId: "tag-test",
    hlc: clock.now(),
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

/** Seed a standalone page (a tag candidate) with the given title. */
function seedPage(id: string, title: string, extra: Record<string, unknown> = {}): void {
  relay.append(
    stamp(
      "object.create",
      {
        objectId: id,
        isEmbedded: false,
        classIds: [],
        contentAst: [{ type: "text", text: title }],
      },
      [id],
    ),
  );
  // Appearance fields ride a follow-up object.update (the create payload
  // carries no appearance keys).
  const { color } = extra;
  if (color !== undefined) {
    relay.append(stamp("object.update", { objectId: id, color }, [id]));
  }
}

/** Seed a class node with the given title. */
function seedClass(id: string, title: string): void {
  relay.append(stamp("class.create", { classId: id, contentAst: [{ type: "text", text: title }] }, [id]));
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "notees-cli-tag-test-"));
  process.env.NOTEES_STATE_FILE = join(stateDir, "state.json");
  for (const name of ["NOTEES_SERVER", "NOTEES_WORKSPACE", "NOTEES_API_KEY", "NOTEES_EMAIL", "NOTEES_PASSWORD"]) {
    delete process.env[name];
  }
  vi.stubGlobal("fetch", relay.fetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.NOTEES_STATE_FILE;
});

beforeEach(() => {
  relay.reset();
  // The CLI's derived store is durable across runs — a fresh workspace per spec.
  rmSync(join(stateDir, "stores"), { recursive: true, force: true });
});

afterEach(() => {
  relay.responders = [];
});

/** Drive the CLI against the fake relay with an explicit server + key. */
async function runCli(io: Capture, ...args: string[]): Promise<number> {
  return run(["--server", BASE, "--key", "test-key", ...args], io);
}

describe("tag assign/unassign", () => {
  it("assigns by page title: resolves through the local store, writes the OR-Set carrier", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    seedPage(TAG_ID, "dispositivos médicos");

    const code = await runCli(io, "tag", "assign", OBJECT_ID, "dispositivos médicos");
    expect(code).toBe(EXIT.ok);
    expect(io.stderrText).toBe("");
    expect(io.stdoutText).toBe(`assigned ${OBJECT_ID} — tags now: ${TAG_ID}\n`);
    // The write rides the outbox as ONE envelope — the object.create carrier
    // carrying the tag OR-Set add (the retired PUT /objects/:id/tags/:tagId
    // route is plan-07 history).
    const batches = relay.batchBodies();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.envelopes).toHaveLength(1);
    expect(batches[0]!.envelopes[0]!.opType).toBe("object.create");
    expect(batches[0]!.envelopes[0]!.payload).toEqual({ objectId: OBJECT_ID, tagIds: [TAG_ID] });
  });

  it("--json prints the objectId/tagId/tagName/tagIds machine shape", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    seedPage(TAG_ID, "Regulation (EU) 2017-745 (MDR)");

    const code = await runCli(io, "--json", "tag", "assign", OBJECT_ID, "Regulation (EU) 2017-745 (MDR)");
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText)).toEqual({
      objectId: OBJECT_ID,
      tagId: TAG_ID,
      tagName: "Regulation (EU) 2017-745 (MDR)",
      tagIds: [TAG_ID],
    });
  });

  it("unassigns by page title via the tag.unassign tombstone and renders an empty tag set as (none)", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    seedPage(TAG_ID, "dispositivos médicos");
    // The object already carries the tag (seeded membership).
    relay.append(stamp("object.create", { objectId: OBJECT_ID, tagIds: [TAG_ID] }, [OBJECT_ID]));

    const code = await runCli(io, "tag", "unassign", OBJECT_ID, "dispositivos médicos");
    expect(code).toBe(EXIT.ok);
    expect(io.stdoutText).toBe(`unassigned ${OBJECT_ID} — tags now: (none)\n`);
    const batches = relay.batchBodies();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.envelopes[0]!.opType).toBe("tag.unassign");
    expect(batches[0]!.envelopes[0]!.payload).toEqual({ objectId: OBJECT_ID, tagId: TAG_ID });
  });

  it("a tag uuid passes through verbatim — no title resolution", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    seedPage(TAG_ID, "the tag page");

    const code = await runCli(io, "tag", "assign", OBJECT_ID, TAG_ID);
    expect(code).toBe(EXIT.ok);
    const batches = relay.batchBodies();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.envelopes[0]!.payload).toEqual({ objectId: OBJECT_ID, tagIds: [TAG_ID] });
  });

  it("title match is case-insensitive, like class assign", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    seedPage(TAG_ID, "Dispositivos Médicos");

    const code = await runCli(io, "tag", "assign", OBJECT_ID, "dispositivos médicos");
    expect(code).toBe(EXIT.ok);
  });

  it("an unknown title is a usage error (exit 2)", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    seedPage(TAG_ID, "something else");

    const code = await runCli(io, "tag", "assign", OBJECT_ID, "no-such-page");
    expect(code).toBe(EXIT.usage);
    expect(io.stderrText).toContain('no page named "no-such-page"');
  });

  it("an ambiguous title is a usage error telling the caller to pass a page id", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    seedPage(TAG_ID, "duplicate");
    seedPage(TAG2_ID, "Duplicate");

    const code = await runCli(io, "tag", "assign", OBJECT_ID, "duplicate");
    expect(code).toBe(EXIT.usage);
    expect(io.stderrText).toContain('page name "duplicate" is ambiguous (2 pages share it) — pass a page id');
  });

  it("class nodes and embedded blocks never resolve as tags (a tag is a page)", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    // Only a CLASS row carries the title → no page named.
    seedClass(TAG_ID, "ghost");
    const classOnly = await runCli(io, "tag", "assign", OBJECT_ID, "ghost");
    expect(classOnly).toBe(EXIT.usage);
    expect(io.stderrText).toContain('no page named "ghost"');

    // A class AND a page share the title → the page wins, single match.
    const io2 = new Capture();
    seedPage(TAG2_ID, "shared");
    const code = await runCli(io2, "tag", "assign", OBJECT_ID, "shared");
    expect(code).toBe(EXIT.ok);
    const batches = relay.batchBodies();
    expect(batches[0]!.envelopes[0]!.payload).toEqual({ objectId: OBJECT_ID, tagIds: [TAG2_ID] });
  });
});

describe("object get tag parity", () => {
  it("human output leads with resolved Classes:/Tags: lines, then the JSON dump", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    seedPage(TAG_ID, "dispositivos médicos");
    seedPage(TAG2_ID, "Regulation (EU) 2017-745 (MDR)", { color: "#aabbcc" });
    relay.append(
      stamp("class.create", { classId: "44444444-4444-7444-8444-444444444444", contentAst: [{ type: "text", text: "book" }] }, ["44444444-4444-7444-8444-444444444444"]),
      stamp("object.create", { objectId: OBJECT_ID, classIds: ["44444444-4444-7444-8444-444444444444"], tagIds: [TAG_ID, TAG2_ID] }, [OBJECT_ID]),
    );

    const code = await runCli(io, "object", "get", OBJECT_ID);
    expect(code).toBe(EXIT.ok);
    expect(io.stdoutText.startsWith("Classes: book\nTags: dispositivos médicos, Regulation (EU) 2017-745 (MDR)\n\n")).toBe(true);
    // The full JSON dump follows the summary lines.
    expect(io.stdoutText).toContain(`"id": "${OBJECT_ID}"`);
  });

  it("renders — when the membership is empty", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "plain");

    const code = await runCli(io, "object", "get", OBJECT_ID);
    expect(code).toBe(EXIT.ok);
    expect(io.stdoutText.startsWith("Classes: —\nTags: —\n\n")).toBe(true);
  });

  it("--json carries the resolved tags/tagIds from the local projection", async () => {
    const io = new Capture();
    seedPage(OBJECT_ID, "the object");
    seedPage(TAG_ID, "dispositivos médicos");
    relay.append(stamp("object.create", { objectId: OBJECT_ID, tagIds: [TAG_ID] }, [OBJECT_ID]));

    const code = await runCli(io, "--json", "object", "get", OBJECT_ID);
    expect(code).toBe(EXIT.ok);
    const machine = JSON.parse(io.stdoutText) as { object: { tagIds: string[]; tags: Array<{ id: string; name: string | null }> } };
    expect(machine.object.tagIds).toEqual([TAG_ID]);
    expect(machine.object.tags).toEqual([{ id: TAG_ID, name: "dispositivos médicos", color: null }]);
  });
});

describe("tag help surface", () => {
  it("the overview lists the tag command; tag assign --help explains the title form", async () => {
    const overview = new Capture();
    expect(await run(["help"], overview)).toBe(EXIT.ok);
    expect(overview.stdoutText).toMatch(/^tag\s\s/m);

    const help = new Capture();
    expect(await run(["help", "tag", "assign"], help)).toBe(EXIT.ok);
    expect(help.stdoutText).toContain("Usage:");
    expect(help.stdoutText).toContain("page uuid or page title");
    expect(help.stdoutText).toContain("idempotent");
  });
});

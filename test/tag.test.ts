import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { run, type CliIo } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";

// Unit specs for the tag surface: the vendored @notees/server predates the
// PUT/DELETE /objects/:id/tags/:tagId routes (they land with the main repo's
// tags-api slice), so these specs mock fetch at the wire level instead of
// booting the real server — the same client path, no live dependency.

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

interface RecordedCall {
  method: string;
  path: string;
}

let calls: RecordedCall[] = [];
// Responder lookup: first match on "METHOD /path/regex" wins; a request with
// no responder fails the spec loudly (a route the test didn't plan for).
let responders: Array<{ method: string; pattern: RegExp; body: (url: URL) => unknown }> = [];

function route(method: string, pattern: RegExp, body: (url: URL) => unknown): void {
  responders.push({ method, pattern, body });
}

beforeAll(() => {
  process.env.NOTEES_STATE_FILE = mkdtempSync(join(tmpdir(), "notees-cli-tag-test-")) + "/state.json";
  for (const name of ["NOTEES_SERVER", "NOTEES_WORKSPACE", "NOTEES_API_KEY", "NOTEES_EMAIL", "NOTEES_PASSWORD"]) {
    delete process.env[name];
  }
  vi.stubGlobal(
    "fetch",
    async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname + url.search });
      const responder = responders.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (responder === undefined) {
        throw new Error(`mock server: no responder for ${method} ${url.pathname}${url.search}`);
      }
      return new Response(JSON.stringify(responder.body(url)), { status: 200 });
    },
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  const stateFile = process.env.NOTEES_STATE_FILE;
  if (stateFile !== undefined) rmSync(join(stateFile, ".."), { recursive: true, force: true });
  delete process.env.NOTEES_STATE_FILE;
});

beforeEach(() => {
  calls = [];
  responders = [];
});

afterEach(() => {
  responders = [];
});

/** Drive the CLI against the mocked wire with an explicit server + key. */
async function runCli(io: Capture, ...args: string[]): Promise<number> {
  return run(["--server", BASE, "--key", "test-key", ...args], io);
}

/** A page-role listing row (what GET /api/objects returns for a tag page). */
function pageRow(id: string, name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name, isClass: false, isEmbedded: false, parentId: null, ...overrides };
}

describe("tag assign/unassign", () => {
  it("assigns by page title: resolves through the object listing, PUTs the tag route", async () => {
    const io = new Capture();
    route("GET", /^\/api\/objects$/, (url) => {
      expect(url.searchParams.get("q")).toBe("dispositivos médicos");
      return { objects: [pageRow(TAG_ID, "dispositivos médicos")] };
    });
    route("PUT", new RegExp(`^/api/objects/${OBJECT_ID}/tags/${TAG_ID}$`), () => ({
      object: { id: OBJECT_ID, tagIds: [TAG_ID] },
    }));

    const code = await runCli(io, "tag", "assign", OBJECT_ID, "dispositivos médicos");
    expect(code).toBe(EXIT.ok);
    expect(io.stderrText).toBe("");
    expect(io.stdoutText).toBe(`assigned ${OBJECT_ID} — tags now: ${TAG_ID}\n`);
    expect(calls).toEqual([
      { method: "GET", path: `/api/objects?q=${encodeURIComponent("dispositivos médicos")}&limit=500` },
      { method: "PUT", path: `/api/objects/${OBJECT_ID}/tags/${TAG_ID}` },
    ]);
  });

  it("--json prints the objectId/tagId/tagName/tagIds machine shape", async () => {
    const io = new Capture();
    route("GET", /^\/api\/objects$/, () => ({ objects: [pageRow(TAG_ID, "Regulation (EU) 2017-745 (MDR)")] }));
    route("PUT", new RegExp(`^/api/objects/${OBJECT_ID}/tags/${TAG_ID}$`), () => ({
      object: { id: OBJECT_ID, tagIds: [TAG_ID] },
    }));

    const code = await runCli(io, "--json", "tag", "assign", OBJECT_ID, "Regulation (EU) 2017-745 (MDR)");
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText)).toEqual({
      objectId: OBJECT_ID,
      tagId: TAG_ID,
      tagName: "Regulation (EU) 2017-745 (MDR)",
      tagIds: [TAG_ID],
    });
  });

  it("unassigns by page title via DELETE and renders an empty tag set as (none)", async () => {
    const io = new Capture();
    route("GET", /^\/api\/objects$/, () => ({ objects: [pageRow(TAG_ID, "dispositivos médicos")] }));
    route("DELETE", new RegExp(`^/api/objects/${OBJECT_ID}/tags/${TAG_ID}$`), () => ({
      object: { id: OBJECT_ID, tagIds: [] },
    }));

    const code = await runCli(io, "tag", "unassign", OBJECT_ID, "dispositivos médicos");
    expect(code).toBe(EXIT.ok);
    expect(io.stdoutText).toBe(`unassigned ${OBJECT_ID} — tags now: (none)\n`);
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
  });

  it("a tag uuid passes through verbatim — no listing call", async () => {
    const io = new Capture();
    route("PUT", new RegExp(`^/api/objects/${OBJECT_ID}/tags/${TAG_ID}$`), () => ({
      object: { id: OBJECT_ID, tagIds: [TAG_ID] },
    }));

    const code = await runCli(io, "tag", "assign", OBJECT_ID, TAG_ID);
    expect(code).toBe(EXIT.ok);
    expect(calls).toEqual([{ method: "PUT", path: `/api/objects/${OBJECT_ID}/tags/${TAG_ID}` }]);
  });

  it("title match is case-insensitive, like class assign", async () => {
    const io = new Capture();
    route("GET", /^\/api\/objects$/, () => ({ objects: [pageRow(TAG_ID, "Dispositivos Médicos")] }));
    route("PUT", new RegExp(`^/api/objects/${OBJECT_ID}/tags/${TAG_ID}$`), () => ({
      object: { id: OBJECT_ID, tagIds: [TAG_ID] },
    }));

    const code = await runCli(io, "tag", "assign", OBJECT_ID, "dispositivos médicos");
    expect(code).toBe(EXIT.ok);
  });

  it("an unknown title is a usage error (exit 2)", async () => {
    const io = new Capture();
    route("GET", /^\/api\/objects$/, () => ({ objects: [pageRow(TAG_ID, "something else")] }));

    const code = await runCli(io, "tag", "assign", OBJECT_ID, "no-such-page");
    expect(code).toBe(EXIT.usage);
    expect(io.stderrText).toContain('no page named "no-such-page"');
  });

  it("an ambiguous title is a usage error telling the caller to pass a page id", async () => {
    const io = new Capture();
    route("GET", /^\/api\/objects$/, () => ({
      objects: [pageRow(TAG_ID, "duplicate"), pageRow(TAG2_ID, "Duplicate")],
    }));

    const code = await runCli(io, "tag", "assign", OBJECT_ID, "duplicate");
    expect(code).toBe(EXIT.usage);
    expect(io.stderrText).toContain('page name "duplicate" is ambiguous (2 pages share it) — pass a page id');
  });

  it("class nodes and embedded blocks never resolve as tags (a tag is a page)", async () => {
    const io = new Capture();
    // Only a CLASS row carries the title → no page named.
    route("GET", /^\/api\/objects$/, () => ({ objects: [pageRow(TAG_ID, "ghost", { isClass: true })] }));
    const classOnly = await runCli(io, "tag", "assign", OBJECT_ID, "ghost");
    expect(classOnly).toBe(EXIT.usage);
    expect(io.stderrText).toContain('no page named "ghost"');

    // A class AND a page share the title → the page wins, single match.
    calls = [];
    const io2 = new Capture();
    responders = [
      {
        method: "GET",
        pattern: /^\/api\/objects$/,
        body: () => ({
          objects: [pageRow(TAG_ID, "shared", { isClass: true }), pageRow(TAG2_ID, "shared")],
        }),
      },
      {
        method: "PUT",
        pattern: new RegExp(`^/api/objects/${OBJECT_ID}/tags/${TAG2_ID}$`),
        body: () => ({ object: { id: OBJECT_ID, tagIds: [TAG2_ID] } }),
      },
    ];
    const code = await runCli(io2, "tag", "assign", OBJECT_ID, "shared");
    expect(code).toBe(EXIT.ok);
    expect(calls.some((c) => c.method === "PUT" && c.path === `/api/objects/${OBJECT_ID}/tags/${TAG2_ID}`)).toBe(true);
  });
});

describe("object get tag parity", () => {
  it("human output leads with resolved Classes:/Tags: lines, then the JSON dump", async () => {
    const io = new Capture();
    route("GET", new RegExp(`^/api/objects/${OBJECT_ID}$`), () => ({
      object: {
        id: OBJECT_ID,
        name: "the object",
        classIds: ["44444444-4444-7444-8444-444444444444"],
        classes: [{ id: "44444444-4444-7444-8444-444444444444", name: "book", icon: null, color: null }],
        tagIds: [TAG_ID, TAG2_ID],
        tags: [
          { id: TAG_ID, name: "dispositivos médicos", color: null },
          { id: TAG2_ID, name: "Regulation (EU) 2017-745 (MDR)", color: "#aabbcc" },
        ],
      },
    }));

    const code = await runCli(io, "object", "get", OBJECT_ID);
    expect(code).toBe(EXIT.ok);
    expect(io.stdoutText.startsWith("Classes: book\nTags: dispositivos médicos, Regulation (EU) 2017-745 (MDR)\n\n")).toBe(true);
    // The full JSON dump follows the summary lines.
    expect(io.stdoutText).toContain(`"id": "${OBJECT_ID}"`);
  });

  it("renders — when the membership is empty or the server predates the tags surface", async () => {
    const io = new Capture();
    // No `classes`/`tags` resolved arrays, no `tagIds` (a server from before
    // the tags surface) — both lines still render, with — for empty.
    route("GET", new RegExp(`^/api/objects/${OBJECT_ID}$`), () => ({
      object: { id: OBJECT_ID, name: "plain", classIds: [] },
    }));

    const code = await runCli(io, "object", "get", OBJECT_ID);
    expect(code).toBe(EXIT.ok);
    expect(io.stdoutText.startsWith("Classes: —\nTags: —\n\n")).toBe(true);
  });

  it("--json passes the server's tags/tagIds through verbatim", async () => {
    const io = new Capture();
    const object = {
      id: OBJECT_ID,
      tagIds: [TAG_ID],
      tags: [{ id: TAG_ID, name: "dispositivos médicos", color: null }],
    };
    route("GET", new RegExp(`^/api/objects/${OBJECT_ID}$`), () => ({ object }));

    const code = await runCli(io, "--json", "object", "get", OBJECT_ID);
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText)).toEqual({ object });
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

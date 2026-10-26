/**
 * `notees import logseq-db <file.sqlite>` — the Logseq DB drift-reconcile
 * command, spec'd against a real server (the suite-wide pattern: one server
 * per file, per-test fresh workspaces via --workspace <uuid>).
 *
 * The Logseq fixture is a REAL sqlite file: the kvs rows are encoded in-test
 * with the transit writer (the same dialect the vendored @notees/export
 * decoder reads — cache-reference handling exercised by construction), then
 * read back through the command's node:sqlite path.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { chainNodeIds } from "@notees/domain";
import { buildServer } from "@notees/server";

import { run, type CliIo } from "../src/cli.js";
import { ApiClient } from "../src/client.js";
import { EXIT } from "../src/exit-codes.js";
import { buildFixtureFile, FIXTURE_DAY_ISO, U } from "./logseq-fixture.js";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

const API_KEY = `nk_${"d".repeat(32)}`;
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

// --- harness --------------------------------------------------------------------

interface Harness {
  app: App;
  dataDir: string;
  baseUrl: string;
  io: Capture;
  fixtureFile: string;
  runCli(workspace: string, ...args: string[]): Promise<number>;
  /** Direct client against a workspace (seeding verbs the CLI lacks, reads). */
  clientFor(workspace: string): ApiClient;
}

let wsCounter = 0;
function freshWorkspace(): string {
  wsCounter += 1;
  return `10000000-0000-4000-8000-${String(wsCounter).padStart(4, "0")}00000000`;
}

async function boot(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "notees-cli-logseqdb-"));
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
      signupEnabled: false,
      resolverTimeoutMs: 10_000,
      corsOrigins: [],
    },
    { logger: false },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const io = new Capture();
  const fixtureFile = buildFixtureFile(dataDir);
  return {
    app,
    dataDir,
    baseUrl,
    io,
    fixtureFile,
    async runCli(workspace, ...args) {
      io.stdoutText = "";
      io.stderrText = "";
      return run(["--server", baseUrl, "--key", API_KEY, "--workspace", workspace, ...args], io);
    },
    clientFor(workspace) {
      return new ApiClient({ server: baseUrl, apiKey: API_KEY, workspace });
    },
  };
}

/** Seeds a workspace with the target-side graph: classes (Obra extends
 * Libro), the mapped property schemas (Linked authors scoped to Libro and
 * filtered to Persona; Fecha scoped to Libro), and the matched/trashed nodes
 * the fixture references. Returns the ids the specs assert against. */
async function seedTarget(h: Harness, ws: string): Promise<{
  libroId: string;
  personaId: string;
  obraId: string;
  sexoMujerOptionId: string;
}> {
  const cli = async (...args: string[]): Promise<void> => {
    const code = await h.runCli(ws, ...args);
    if (code !== EXIT.ok) throw new Error(`seed ${args.join(" ")} failed (${code}): ${h.io.stderrText}`);
  };
  const json = async <T>(...args: string[]): Promise<T> => {
    await cli("--json", ...args);
    return JSON.parse(h.io.stdoutText) as T;
  };

  const createClass = async (name: string): Promise<string> => {
    const res = await json<{ id: string }>("object", "create", "--isClass", "--name", name);
    return res.id;
  };
  const libroId = await createClass("Libro");
  const personaId = await createClass("Persona");
  const obraId = await createClass("Obra");
  await cli("class", "set-extends", obraId, libroId, "--yes");

  const createSchema = async (name: string, extra: string[]): Promise<{ id: string }> => {
    const res = await json<{ propertySchema: { id: string } }>(
      "property", "create", name, ...extra,
    );
    return res.propertySchema;
  };
  const linked = await createSchema("Linked authors", ["--type", "object", "--multi", "--targetClass", personaId]);
  await createSchema("Consumido", ["--type", "boolean"]);
  const fecha = await createSchema("Fecha", ["--type", "datetime"]);
  const sexo = await createSchema("Sexo", ["--type", "select", "--option", "Mujer", "--option", "Hombre"]);
  await createSchema("NIF", ["--type", "text"]);

  // Scope verbs the CLI does not expose ride the same REST surface the web
  // app's bindings editor uses (propertySchema.update).
  const client = h.clientFor(ws);
  await client.patchJson(`/api/property-schemas/${linked.id}`, { scopeClassIds: [libroId] });
  await client.patchJson(`/api/property-schemas/${fecha.id}`, { scopeClassIds: [libroId] });
  const sexoDetail = await client.getJson<{ propertySchema: { options: Array<{ id: string; label: string }> } }>(
    `/api/property-schemas/${sexo.id}`,
  );
  const sexoMujerOptionId = sexoDetail.propertySchema.options.find((o) => o.label === "Mujer")?.id as string;

  // Matched nodes (fixture uuids), preserving the Logseq ids.
  const createWithId = async (id: string, name: string, classId: string): Promise<void> => {
    await client.postJson("/api/objects", {
      id,
      isEmbedded: false,
      contentAst: [{ type: "text", text: name }],
      classIds: [classId],
    });
  };
  await createWithId(U.page1, "Página uno", libroId);
  await createWithId(U.newerTitle, "Título Notees", libroId);
  await createWithId(U.olderTitle, "Título Notees viejo", libroId);
  // The orphan exists on both sides but is TRASHED in Notees.
  await createWithId(U.orphan, "Libro huérfano", libroId);
  await cli("object", "delete", U.orphan, "--yes");

  return { libroId, personaId, obraId, sexoMujerOptionId };
}

interface ImportReport {
  workspace: string | null;
  targetNodes: number;
  export: { nodes: number; matched: number; missing: number; skipped: Record<string, number> };
  classes: { mapped: number; unmapped: Record<string, number> };
  properties: { mapped: number; unmapped: string[]; newSchemas: string[] };
  plan: Record<string, number> & {
    creates: number;
    chainCreates: number;
    titleUpdates: number;
    titleKeepNotees: number;
    propFills: number;
    propRestores: number;
    propFailures: number;
    schemaCreates: number;
  };
  createWarnings: number;
  trashedSkipped: number;
  dryRun: boolean;
  strategy: string;
  restoreDiffs: boolean;
  ops: {
    creates: Array<{ id: string; parentId: string | null }>;
    propFills: Array<{ nodeId: string; schemaName: string; values: unknown[] }>;
    propFailures: Array<{ nodeId?: string; schema: string; reason: string }>;
    [key: string]: unknown;
  };
  executionFailures?: Array<{ kind: string; id: string; error: string }>;
}

// --- specs ------------------------------------------------------------------------

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

afterAll(async () => {
  await h.app.close();
  rmSync(h.dataDir, { recursive: true, force: true });
});

describe("import logseq-db", () => {
  it("decodes the export and plans a dry run that writes nothing", async () => {
    const ws = freshWorkspace();
    // A dry run on an empty (seeded-only) workspace: everything plans, nothing lands.
    const code = await h.runCli(ws, "--json", "import", "logseq-db", h.fixtureFile);
    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(h.io.stdoutText) as ImportReport;
    expect(report.dryRun).toBe(true);
    expect(report.export.nodes).toBe(9);
    expect(report.export.matched).toBe(0);
    expect(report.export.missing).toBe(9);
    expect(report.export.skipped).toEqual({ views: 2, system: 2, assets: 1, closedValues: 2 });
    expect(report.classes.mapped).toBe(0); // no user classes in the workspace yet
    expect(Object.keys(report.classes.unmapped)).toEqual(["Libro", "Obra", "Persona"]);
    expect(report.properties.mapped).toBe(1); // only the seeded system "Linked authors" exists target-side
    expect(report.properties.unmapped).toEqual(["Consumido", "Fecha", "Sexo", "nif"]);
    expect(report.plan.creates).toBe(9);
    expect(report.plan.chainCreates).toBe(3); // 2026-10-25 year/month/day
    expect(report.trashedSkipped).toBe(0);
    expect(h.io.stderrText).toContain("target.read");

    // Nothing was written: no fixture id exists on either side of the trash.
    const active = await h.clientFor(ws).getJson<{ objects: Array<{ id: string }> }>("/api/objects?limit=500");
    expect(active.objects.some((o) => o.id === U.page1)).toBe(false);
    const trashed = await h.clientFor(ws).getJson<{ objects: Array<{ id: string }> }>(
      "/api/objects?limit=500&trashed=true",
    );
    expect(trashed.objects.some((o) => o.id === U.page1)).toBe(false);
  });

  it("fails loud on a missing file and a non-Logseq sqlite", async () => {
    const ws = freshWorkspace();
    expect(await h.runCli(ws, "import", "logseq-db", join(h.dataDir, "nope.sqlite"))).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("file not found");

    const notLogseq = join(h.dataDir, "other.sqlite");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(notLogseq);
    db.exec("CREATE TABLE things (id INTEGER)");
    db.close();
    expect(await h.runCli(ws, "import", "logseq-db", notLogseq)).toBe(EXIT.domain);
    expect(h.io.stderrText).toContain("kvs");
  });

  it("rejects --dry-run combined with --write/--yes", async () => {
    const ws = freshWorkspace();
    expect(await h.runCli(ws, "import", "logseq-db", h.fixtureFile, "--dry-run", "--write")).toBe(EXIT.usage);
  });

  it("fills missing values under notees-wins, creates with preserved uuids, and skips trashed nodes", async () => {
    const ws = freshWorkspace();
    await seedTarget(h, ws);

    const code = await h.runCli(ws, "--json", "import", "logseq-db", h.fixtureFile, "--write");
    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(h.io.stdoutText) as ImportReport;
    expect(report.dryRun).toBe(false);
    expect(report.strategy).toBe("notees-wins");
    expect(report.export.matched).toBe(3);
    expect(report.export.missing).toBe(5);
    expect(report.trashedSkipped).toBe(1);
    // notees-wins: differing titles are kept, never written.
    expect(report.plan.titleUpdates).toBe(0);
    expect(report.plan.titleKeepNotees).toBe(2);
    expect(report.executionFailures ?? []).toEqual([]);

    const client = h.clientFor(ws);
    const get = async (id: string) =>
      client.getJson<{ object: { id: string; name: string | null; parentId: string | null; properties?: Array<{ schemaName: string; value: unknown }> } }>(
        `/api/objects/${id}`,
      ).then((b) => b.object);

    // Creates preserve the Logseq uuids; the persona and both blocks exist.
    const ada = await get(U.ada);
    expect(ada.name).toBe("Ada Lovelace");

    // Sibling order follows the Logseq fractional order (a0 before a1).
    const children = await client.getJson<{ children: Array<{ id: string; name: string | null }> }>(
      `/api/objects/${U.page1}/children`,
    );
    expect(children.children.map((c) => c.id)).toEqual([U.block1, U.block2]);

    // The daily note lands under the deterministic day node of the date chain.
    const daily = await get(U.daily);
    expect(daily.parentId).toBe(chainNodeIds(FIXTURE_DAY_ISO).day);

    // Fills on the matched page: every mapped property landed typed.
    const page1 = await get(U.page1);
    const props = new Map(page1.properties?.map((p) => [p.schemaName, p.value]));
    expect(props.get("NIF")).toBe("12345678Z");
    expect(props.get("Consumido")).toBe(true);
    expect(props.get("Sexo")).toBe(await sexoOptionId(ws));
    expect(props.get("Fecha")).toEqual({ nodeId: chainNodeIds(FIXTURE_DAY_ISO).day });
    expect(props.get("Linked authors")).toEqual({ nodeId: U.ada });

    // Titles: Notees wins under the default strategy.
    expect((await get(U.newerTitle)).name).toBe("Título Notees");
    expect((await get(U.olderTitle)).name).toBe("Título Notees viejo");

    // Trashed: still trashed, not recreated.
    const inactive = await client.getJson<{ objects: Array<{ id: string }> }>(
      `/api/objects?limit=500&trashed=true`,
    );
    expect(inactive.objects.some((o) => o.id === U.orphan)).toBe(true);
    const active = await client.getJson<{ objects: Array<{ id: string }> }>("/api/objects?limit=500");
    expect(active.objects.some((o) => o.id === U.orphan)).toBe(false);
  });

  it("applies extends-aware scope eligibility both directions", async () => {
    const ws = freshWorkspace();
    await seedTarget(h, ws);
    const code = await h.runCli(ws, "--json", "import", "logseq-db", h.fixtureFile, "--write");
    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(h.io.stdoutText) as ImportReport;

    // block2 carries Fecha but is classed Persona only — ineligible (scope Libro).
    const ineligible = report.ops.propFailures.filter(
      (f) => f.schema === "Fecha" && f.reason === "ineligible-scope",
    );
    expect(ineligible.some((f) => f.nodeId === U.block2)).toBe(true);

    // The Obra node qualifies through Obra extends Libro — its Fecha filled.
    const obraFill = report.ops.propFills.find(
      (f) => f.nodeId === U.obraNode && f.schemaName === "Fecha",
    );
    expect(obraFill).toBeDefined();
    const client = h.clientFor(ws);
    const obraNode = await client.getJson<{
      object: { properties?: Array<{ schemaName: string; value: unknown }> };
    }>(`/api/objects/${U.obraNode}`);
    expect(
      obraNode.object.properties?.find((p) => p.schemaName === "Fecha")?.value,
    ).toEqual({ nodeId: chainNodeIds(FIXTURE_DAY_ISO).day });
  });

  it("plans nothing on an idempotent re-run", async () => {
    const ws = freshWorkspace();
    await seedTarget(h, ws);
    expect(await h.runCli(ws, "--json", "import", "logseq-db", h.fixtureFile, "--write")).toBe(EXIT.ok);

    const code = await h.runCli(ws, "--json", "import", "logseq-db", h.fixtureFile);
    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(h.io.stdoutText) as ImportReport;
    expect(report.export.matched).toBe(8); // 9 export nodes minus the trashed orphan
    expect(report.export.missing).toBe(0);
    expect(report.trashedSkipped).toBe(1); // the trashed orphan still reserves its id
    expect(report.plan.creates).toBe(0);
    expect(report.plan.chainCreates).toBe(0);
    expect(report.plan.propFills).toBe(0);
    expect(report.plan.titleUpdates).toBe(0);
    expect(report.plan.propRestores).toBe(0);
  });

  it("newer-wins writes titles only when the Logseq timestamp is strictly newer", async () => {
    const ws = freshWorkspace();
    await seedTarget(h, ws);
    const code = await h.runCli(
      ws, "--json", "import", "logseq-db", h.fixtureFile, "--write", "--strategy", "newer-wins",
    );
    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(h.io.stdoutText) as ImportReport;
    expect(report.plan.titleUpdates).toBe(1);
    expect(report.plan.titleKeepNotees).toBe(1);

    const client = h.clientFor(ws);
    const nameOf = async (id: string): Promise<string | null> =>
      client.getJson<{ object: { name: string | null } }>(`/api/objects/${id}`).then((b) => b.object.name);
    // Strictly newer → the Logseq title lands.
    expect(await nameOf(U.newerTitle)).toBe("Título Logseq");
    // Older → Notees keeps its title.
    expect(await nameOf(U.olderTitle)).toBe("Título Notees viejo");
  });

  it("restore-diffs gates the clobbering restores", async () => {
    // Workspace A (default): a differing value is reported as a restore but NOT applied.
    const wsA = freshWorkspace();
    await seedTarget(h, wsA);
    await h.clientFor(wsA).postJson(`/api/objects/${U.page1}/properties`, {
      propertySchemaId: await schemaId(wsA, "NIF"),
      value: "OLDVALUE",
      idx: 0,
    });
    expect(await h.runCli(wsA, "--json", "import", "logseq-db", h.fixtureFile, "--write")).toBe(EXIT.ok);
    let report = JSON.parse(h.io.stdoutText) as ImportReport;
    expect(report.plan.propRestores).toBe(1);
    const nifOf = async (ws: string): Promise<unknown> =>
      h.clientFor(ws).getJson<{ object: { properties?: Array<{ schemaName: string; value: unknown }> } }>(
        `/api/objects/${U.page1}`,
      ).then((b) => b.object.properties?.find((p) => p.schemaName === "NIF")?.value);
    expect(await nifOf(wsA)).toBe("OLDVALUE");

    // Workspace B (--restore-diffs): the differing value is clobbered from Logseq.
    const wsB = freshWorkspace();
    await seedTarget(h, wsB);
    await h.clientFor(wsB).postJson(`/api/objects/${U.page1}/properties`, {
      propertySchemaId: await schemaId(wsB, "NIF"),
      value: "OLDVALUE",
      idx: 0,
    });
    expect(
      await h.runCli(wsB, "--json", "import", "logseq-db", h.fixtureFile, "--write", "--restore-diffs"),
    ).toBe(EXIT.ok);
    report = JSON.parse(h.io.stdoutText) as ImportReport;
    expect(report.plan.propRestores).toBe(1);
    expect(report.restoreDiffs).toBe(true);
    expect(await nifOf(wsB)).toBe("12345678Z");
  });
});

async function schemaId(ws: string, name: string): Promise<string> {
  const body = await h.clientFor(ws).getJson<{ propertySchemas: Array<{ id: string; name: string }> }>(
    "/api/property-schemas",
  );
  const hit = body.propertySchemas.find((s) => s.name === name);
  if (hit === undefined) throw new Error(`schema ${name} not seeded in ${ws}`);
  return hit.id;
}

async function sexoOptionId(ws: string): Promise<string> {
  const id = await schemaId(ws, "Sexo");
  const body = await h.clientFor(ws).getJson<{
    propertySchema: { options: Array<{ id: string; label: string }> };
  }>(`/api/property-schemas/${id}`);
  return body.propertySchema.options.find((o) => o.label === "Mujer")?.id as string;
}

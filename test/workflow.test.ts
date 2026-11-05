import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Clock, newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_PROPERTY_UUIDS, planWorkflowToggle } from "@notees/domain";

import { run, type CliIo } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";
import { DEFAULT_WORKSPACE_ID } from "../src/uuid.js";

import { FakeRelay } from "./fake-relay.js";

// Unit specs for the workflow + feature surface over the plan-07 local-first
// architecture: the CLI syncs through the relay wire protocol into a local
// derived store (test/fake-relay.ts implements that wire over an in-memory
// envelope log); the convergence probes read the local store; the writes ride
// the outbox as envelopes. Graph state is seeded by appending envelopes to
// the fake relay's log — every CLI run syncs first, so the command under test
// sees the seed. The pinned ids below are the derived-UUID snapshot from
// @notees/domain's workflow registry.

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

// The research workflow's deterministic ids (workflowEntityId literals).
const ANCHOR_ID = "004138e7-4033-55fa-9cca-aba337b1f741";
const SYNTHESIS_CLASS_ID = "4b7613a7-c050-5dd7-9f49-586d26797b08";
const COMPARISON_CLASS_ID = "a1bfbf36-b734-5345-97aa-3c638b09b094";
const SOURCE_INSTANCE_CLASS_ID = "38816bed-fc56-5168-b1e6-14eebbfb12a6";
const WRITING_PLAN_TEMPLATE_ID = "e91c8f08-54b6-52db-b59d-48ef2829b4a3";
const COMPARISON_TEMPLATE_ID = "22198480-6aa0-511f-b6c5-8e09515df91b";
const WRITING_PLAN_HAS_TEMPLATE_ELEMENT = "405ee13a-7512-5c37-a09f-05e7a41bf031";

const BASE = "http://notees-mock.test";

const relay = new FakeRelay();
let stateDir = "";

const clock = new Clock("workflow-test");
/** A stamped envelope for the fake relay's log (the seed path). */
function stamp(opType: string, payload: Record<string, unknown>, affected: string[] = []): Envelope {
  return newEnvelope({
    workspaceId: DEFAULT_WORKSPACE_ID,
    actorId: "99999999-8888-4777-8666-555555555555",
    deviceId: "workflow-test",
    hlc: clock.now(),
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

/** Stamp every step of a workflow plan onto the fake relay's log. */
function seedPlan(target: "enabled" | "disabled"): void {
  for (const step of planWorkflowToggle("research", target)) {
    const id = step.payload.objectId ?? step.payload.classId;
    relay.append(
      stamp(step.opType, step.payload as Record<string, unknown>, typeof id === "string" ? [id] : []),
    );
  }
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "notees-cli-workflow-test-"));
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

/** Every relay-batch POST recorded so far. */
function batchPosts(): Array<{ method: string; path: string }> {
  return relay.calls.filter((call) => call.method === "POST" && call.path === "/api/relay/v2/batch");
}

describe("workflow list (anchor-only probe)", () => {
  it("an empty workspace reads available — the probe is ONE local store read, no content route on the wire", async () => {
    const io = new Capture();

    const code = await runCli(io, "--json", "workflow", "list");
    expect(code).toBe(EXIT.ok);
    // No content API route exists on the wire anymore (plan 07 retired it);
    // the only traffic is the sync cycle (key probe + snapshot meta + catch-up).
    expect(relay.calls.every((call) => !call.path.startsWith("/api/objects"))).toBe(true);
    // Two catch-up cycles: the bootstrap sync, then the keyless seed-shim
    // poke's pull (the empty-store /api/classes trigger).
    expect(relay.calls.filter((call) => call.path === "/api/relay/v2/catch-up")).toHaveLength(2);
    expect(JSON.parse(io.stdoutText)).toEqual({
      workflows: [
        { id: "research", label: "Research", state: "available", anchorId: ANCHOR_ID },
      ],
    });
  });

  it("human table renders the label as the first column", async () => {
    const io = new Capture();

    expect(await runCli(io, "workflow", "list")).toBe(EXIT.ok);
    expect(io.stdoutText).toMatch(/^LABEL\s+/m);
    expect(io.stdoutText).toMatch(/Research\s+research\s+available\s+/);
  });

  it("present + active reads installed; present + archived reads disabled", async () => {
    // Seed the anchor as an active node.
    relay.append(stamp("object.create", { objectId: ANCHOR_ID, isEmbedded: false, classIds: [] }, [ANCHOR_ID]));
    const io = new Capture();
    expect(await runCli(io, "--json", "workflow", "list")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText).workflows[0].state).toBe("installed");

    // Seed the anchor as archived (a later update wins the LWW read).
    relay.append(stamp("object.update", { objectId: ANCHOR_ID, active: false }, [ANCHOR_ID]));
    const io2 = new Capture();
    expect(await runCli(io2, "--json", "workflow", "list")).toBe(EXIT.ok);
    expect(JSON.parse(io2.stdoutText).workflows[0].state).toBe("disabled");
  });
});

describe("workflow enable (planWorkflowToggle → one relay batch)", () => {
  it("posts ONE batch with the full 48-step enable plan, anchor first", async () => {
    const io = new Capture();

    const code = await runCli(io, "--json", "workflow", "enable", "research");
    expect(code).toBe(EXIT.ok);
    expect(batchPosts()).toHaveLength(1);

    expect(relay.batchBodies()).toHaveLength(1);
    const envelopes = relay.batchBodies()[0]!.envelopes;
    expect(envelopes).toHaveLength(48);

    // Anchor first: object.create at the derived anchor id.
    expect(envelopes[0]!.opType).toBe("object.create");
    expect(envelopes[0]!.payload.objectId).toBe(ANCHOR_ID);
    expect(envelopes[0]!.client).toBe("cli");
    expect(envelopes[0]!.deviceId).toBe("notees-cli");

    // The three workflow classes derive their ids.
    const classCreates = envelopes.filter((e: { opType: string }) => e.opType === "class.create");
    expect(classCreates.map((e) => String(e.payload.classId))).toEqual([
      SYNTHESIS_CLASS_ID,
      COMPARISON_CLASS_ID,
      SOURCE_INSTANCE_CLASS_ID,
    ]);

    // 15 schemas + 7 bindings + 2 has-template values.
    expect(envelopes.filter((e: { opType: string }) => e.opType === "propertySchema.create")).toHaveLength(15);
    expect(envelopes.filter((e: { opType: string }) => e.opType === "class.property.set")).toHaveLength(7);
    const hasTemplate = envelopes.filter(
      (e: { opType: string; payload: Record<string, unknown> }) =>
        e.opType === "property.set" && e.payload.propertySchemaId === SYSTEM_PROPERTY_UUIDS.hasTemplate,
    );
    expect(hasTemplate).toHaveLength(2);
    // The has-template OR-Set add rides the deterministic element id.
    expect(hasTemplate[0]!.payload.elementId).toBe(WRITING_PLAN_HAS_TEMPLATE_ELEMENT);
    expect(hasTemplate[0]!.payload.value).toEqual({ nodeId: WRITING_PLAN_TEMPLATE_ID });

    expect(JSON.parse(io.stdoutText)).toEqual({
      workflow: "research",
      target: "enabled",
      state: "installed",
      applied: 48,
      skipped: 0,
    });
  });

  it("un-archives an archived anchor with object.update {active:true} instead of a create", async () => {
    // The anchor exists but is archived; everything else is absent.
    relay.append(stamp("object.create", { objectId: ANCHOR_ID, isEmbedded: false, classIds: [] }, [ANCHOR_ID]));
    relay.append(stamp("object.update", { objectId: ANCHOR_ID, active: false }, [ANCHOR_ID]));
    const io = new Capture();

    expect(await runCli(io, "workflow", "enable", "research")).toBe(EXIT.ok);
    const envelopes = relay.batchBodies()[0]!.envelopes;
    expect(envelopes[0]!.opType).toBe("object.update");
    expect(envelopes[0]!.payload).toEqual({ objectId: ANCHOR_ID, active: true });
  });

  it("a converged re-enable writes ONLY the 7 binding upserts (no REST binding read exists)", async () => {
    // Seed the fully-converged state: the whole enable plan applied, plus the
    // schema listing the convergence check reads (a surviving coordination route).
    seedPlan("enabled");
    const plan = planWorkflowToggle("research", "enabled");
    relay.propertySchemas = plan
      .filter((step) => step.opType === "propertySchema.create")
      .map((step) => ({ id: String(step.payload.propertySchemaId) }));
    const io = new Capture();

    const code = await runCli(io, "--json", "workflow", "enable", "research");
    expect(code).toBe(EXIT.ok);
    expect(batchPosts()).toHaveLength(1);
    const envelopes = relay.batchBodies()[0]!.envelopes;
    expect(envelopes).toHaveLength(7);
    for (const envelope of envelopes) expect(envelope.opType).toBe("class.property.set");
    expect(JSON.parse(io.stdoutText)).toEqual({
      workflow: "research",
      target: "enabled",
      state: "installed",
      applied: 7,
      skipped: 41,
    });
  });
});

describe("workflow disable (archive shape)", () => {
  it("posts ONE batch of 6 object.update {active:false} — anchor first, then classes, then templates", async () => {
    // Seed every materialized entity as an active node (the enable plan).
    seedPlan("enabled");
    const io = new Capture();

    const code = await runCli(io, "--json", "workflow", "disable", "research");
    expect(code).toBe(EXIT.ok);
    expect(batchPosts()).toHaveLength(1);
    const envelopes = relay.batchBodies()[0]!.envelopes;
    expect(envelopes.map((e: { opType: string }) => e.opType)).toEqual([
      "object.update",
      "object.update",
      "object.update",
      "object.update",
      "object.update",
      "object.update",
    ]);
    expect(envelopes.map((e) => String(e.payload.objectId))).toEqual([
      ANCHOR_ID,
      SYNTHESIS_CLASS_ID,
      COMPARISON_CLASS_ID,
      SOURCE_INSTANCE_CLASS_ID,
      WRITING_PLAN_TEMPLATE_ID,
      COMPARISON_TEMPLATE_ID,
    ]);
    for (const envelope of envelopes) expect(envelope.payload.active).toBe(false);
    expect(JSON.parse(io.stdoutText)).toEqual({
      workflow: "research",
      target: "disabled",
      state: "disabled",
      applied: 6,
      skipped: 0,
    });
  });

  it("a fully-disabled workflow writes nothing (no batch at all)", async () => {
    // Seed the enable plan, then archive everything (the disable plan).
    seedPlan("enabled");
    seedPlan("disabled");
    const io = new Capture();

    const code = await runCli(io, "--json", "workflow", "disable", "research");
    expect(code).toBe(EXIT.ok);
    expect(batchPosts()).toHaveLength(0);
    expect(JSON.parse(io.stdoutText)).toEqual({
      workflow: "research",
      target: "disabled",
      state: "disabled",
      applied: 0,
      skipped: 6,
    });
  });
});

describe("feature list (GET /api/features)", () => {
  it("defaults untoggled features to enabled and parses the toggled rows", async () => {
    const io = new Capture();
    relay.features = [
      { feature: "sources", enabled: false, settings: { citekeyPattern: "{{author}}{{year}}" } },
      { feature: "journal", enabled: false, settings: null },
    ];

    const code = await runCli(io, "--json", "feature", "list");
    expect(code).toBe(EXIT.ok);
    expect(relay.calls.filter((call) => call.path === "/api/features")).toHaveLength(1);
    const { features } = JSON.parse(io.stdoutText) as { features: Array<{ feature: string; label: string; enabled: boolean; settings: unknown }> };
    expect(features).toHaveLength(6);
    const byFeature = new Map(features.map((row) => [row.feature, row]));
    expect(byFeature.get("sources")).toEqual({
      feature: "sources",
      label: "Sources",
      enabled: false,
      settings: { citekeyPattern: "{{author}}{{year}}" },
    });
    expect(byFeature.get("journal")).toEqual({ feature: "journal", label: "Journal", enabled: false, settings: null });
    for (const name of ["tasks", "events", "meetings", "persons"]) {
      expect(byFeature.get(name)?.enabled).toBe(true);
      expect(byFeature.get(name)?.settings).toBeNull();
    }
  });
});

describe("feature enable|disable (read-modify-merged settings)", () => {
  it("a plain toggle carries an existing settings record forward (never wiped)", async () => {
    const io = new Capture();
    const settings = { citekeyPattern: "{{author}}{{year}}", importBehavior: "merge" };
    relay.features = [{ feature: "sources", enabled: true, settings }];

    const code = await runCli(io, "--json", "feature", "disable", "sources");
    expect(code).toBe(EXIT.ok);
    expect(relay.batchBodies()).toHaveLength(1);
    const envelope = relay.batchBodies()[0]?.envelopes[0];
    expect(envelope?.opType).toBe("workspace.feature.set");
    expect(envelope?.payload).toEqual({ feature: "sources", enabled: false, settings });
    expect(envelope?.affectedNodeIds).toEqual([]);
    expect(JSON.parse(io.stdoutText)).toEqual({
      feature: "sources",
      label: "Sources",
      enabled: false,
      settings,
    });
  });

  it("a toggle against an untoggled row writes {feature, enabled} with NO settings key", async () => {
    const io = new Capture();
    relay.features = [];

    expect(await runCli(io, "feature", "enable", "tasks")).toBe(EXIT.ok);
    const envelope = relay.batchBodies()[0]?.envelopes[0];
    expect(envelope?.payload).toEqual({ feature: "tasks", enabled: true });
    expect(envelope !== undefined && "settings" in envelope.payload).toBe(false);
  });
});

describe("usage errors", () => {
  it("an unknown workflow id is a usage error before any wire call", async () => {
    const io = new Capture();
    const code = await runCli(io, "workflow", "enable", "nope");
    expect(code).toBe(EXIT.usage);
    expect(io.stderrText).toContain('unknown workflow "nope"');
    expect(relay.calls).toHaveLength(0);
  });

  it("an unknown feature is a usage error listing the known features", async () => {
    const io = new Capture();
    const code = await runCli(io, "feature", "enable", "nope");
    expect(code).toBe(EXIT.usage);
    expect(io.stderrText).toContain('unknown feature "nope"');
    expect(relay.calls).toHaveLength(0);
  });
});

describe("workflow/feature help surface", () => {
  it("the overview lists both commands; workflow enable --help explains the idempotent batch", async () => {
    const overview = new Capture();
    expect(await run(["help"], overview)).toBe(EXIT.ok);
    expect(overview.stdoutText).toMatch(/^workflow\s\s/m);
    expect(overview.stdoutText).toMatch(/^feature\s\s/m);

    const help = new Capture();
    expect(await run(["help", "workflow", "enable"], help)).toBe(EXIT.ok);
    expect(help.stdoutText).toContain("Usage:");
    expect(help.stdoutText).toContain("idempotent");
  });
});

// --- e2e against the real vendored server ------------------------------------
//
// The live relay drives the whole local-first path for real: the sync cycle
// (catch-up pull), the convergence probes over the local projection, and the
// outbox push the engine batches.

import { buildServer, defaultWorkspaceId } from "@notees/server";

import { ApiClient } from "../src/client.js";

const E2E_API_KEY = `nk_${"w".repeat(32)}`;

describe("e2e: workflow + feature against the vendored server", () => {
  let baseUrl = "";
  let app: { close: () => Promise<void> };
  let io: Capture;
  let client: ApiClient;
  let e2eStateDir = "";

  beforeAll(async () => {
    vi.unstubAllGlobals(); // restore real fetch for the live server
    e2eStateDir = mkdtempSync(join(tmpdir(), "notees-cli-workflow-e2e-"));
    process.env.NOTEES_STATE_FILE = join(e2eStateDir, "state.json");
    const dataDir = mkdtempSync(join(tmpdir(), "notees-cli-workflow-e2e-data-"));
    const built = await buildServer(
      {
        dataDir,
        apiKey: E2E_API_KEY,
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
    app = built.app;
    await built.app.listen({ port: 0, host: "127.0.0.1" });
    const address = built.app.server.address();
    if (address === null || typeof address === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    io = new Capture();
    client = new ApiClient({ server: baseUrl, apiKey: E2E_API_KEY });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    rmSync(e2eStateDir, { recursive: true, force: true });
    delete process.env.NOTEES_STATE_FILE;
  });

  async function runLive(...args: string[]): Promise<number> {
    io.stdoutText = "";
    io.stderrText = "";
    return run(["--server", baseUrl, "--key", E2E_API_KEY, ...args], io);
  }

  it("the full toggle lifecycle: available → enable (48 ops) → installed → re-enable converges → disable (6 ops) → disabled", async () => {
    expect(await runLive("--json", "workflow", "list")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText).workflows[0].state).toBe("available");

    expect(await runLive("--json", "workflow", "enable", "research")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText)).toMatchObject({ workflow: "research", applied: 48, skipped: 0 });

    expect(await runLive("--json", "workflow", "list")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText).workflows[0].state).toBe("installed");

    // The anchor page exists for real (read locally, synced from the relay).
    expect(await runLive("object", "get", ANCHOR_ID)).toBe(EXIT.ok);
    expect(io.stdoutText).toContain(ANCHOR_ID);

    // Re-enable: everything converges except the 7 binding upserts (no REST
    // binding read exists — content-preserving COALESCE no-ops).
    expect(await runLive("--json", "workflow", "enable", "research")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText)).toMatchObject({ applied: 7, skipped: 41 });

    expect(await runLive("--json", "workflow", "disable", "research")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText)).toMatchObject({ applied: 6, skipped: 0 });

    expect(await runLive("--json", "workflow", "list")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText).workflows[0].state).toBe("disabled");

    // Re-disable of a disabled workflow writes nothing.
    expect(await runLive("--json", "workflow", "disable", "research")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText)).toMatchObject({ applied: 0, skipped: 6 });
  }, 30_000);

  it("un-archive after disable: enable restores an installed state", async () => {
    expect(await runLive("--json", "workflow", "enable", "research")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText).state).toBe("installed");
    expect(await runLive("--json", "workflow", "list")).toBe(EXIT.ok);
    expect(JSON.parse(io.stdoutText).workflows[0].state).toBe("installed");
  }, 30_000);

  it("feature list defaults every feature on; a toggle preserves a seeded settings record", async () => {
    expect(await runLive("--json", "feature", "list")).toBe(EXIT.ok);
    const listed = JSON.parse(io.stdoutText).features as Array<{ feature: string; enabled: boolean }>;
    expect(listed).toHaveLength(6);
    expect(listed.every((row) => row.enabled)).toBe(true);

    // Seed a Sources settings record the way the web seam writes it.
    // A PAST hlc: the CLI's toggle below must win the LWW race (the crafted
    // seed is the older row).
    const seed = newEnvelope({
      workspaceId: defaultWorkspaceId(),
      actorId: "99999999-8888-4777-8666-555555555555",
      deviceId: "test",
      hlc: { physical: Date.now() - 60_000, logical: 0 },
      affectedNodeIds: [],
      opType: "workspace.feature.set",
      payload: { feature: "sources", enabled: true, settings: { citekeyPattern: "{{author}}{{year}}" } },
    });
    const seedRes = await fetch(`${baseUrl}/api/relay/v2/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": E2E_API_KEY },
      body: JSON.stringify({ envelopes: [seed] }),
    });
    expect(seedRes.status).toBe(200);

    // A plain CLI toggle must carry the settings forward, never wipe them.
    expect(await runLive("--json", "feature", "disable", "sources")).toBe(EXIT.ok);
    const after = await client.getJson<{ features: Array<{ feature: string; enabled: boolean; settings: unknown }> }>("/api/features");
    const sources = after.features.find((row) => row.feature === "sources");
    expect(sources?.enabled).toBe(false);
    expect(sources?.settings).toEqual({ citekeyPattern: "{{author}}{{year}}" });
    expect(JSON.parse(io.stdoutText).settings).toEqual({ citekeyPattern: "{{author}}{{year}}" });
  }, 30_000);
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServer, defaultWorkspaceId } from "@notees/server";

import { run, type CliIo } from "../../src/cli.js";

export const API_KEY = `nk_${"c".repeat(32)}`;

export class Capture implements CliIo {
  stdoutText = "";
  stderrText = "";
  isTty = false;
  stdout = { write: (chunk: string) => { this.stdoutText += chunk; } };
  stderr = { write: (chunk: string) => { this.stderrText += chunk; } };
}

export interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>["app"];
  server: import("node:net").Server;
  baseUrl: string;
  dataDir: string;
  stateFile: string;
  runCli(...args: string[]): Promise<number>;
  seedObject(name: string, classIds: string[]): Promise<string>;
  seedProperty(objectId: string, schemaId: string, value: unknown): Promise<void>;
  close(): Promise<void>;
}

export async function bootServer(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "notees-serve-test-"));
  const stateFile = join(dataDir, "cli-state.json");
  // The operator shell may export NOTEES_* defaults (the fleet host does) —
  // blank them for the harness run and point the CLI state file at the
  // harness temp dir, so stored defaults/credentials/stores from the
  // developer's real ~/.notees can never leak into the tests (mirrors
  // test/cli.test.ts). A fresh state dir also means the FIRST seeded CLI
  // call opens an empty store, so its bootstrap fires the server-side seed
  // shim (GET /api/classes) and the system classes enter the relay log
  // before any object is created.
  const savedEnv: Record<string, string | undefined> = {};
  process.env.NOTEES_STATE_FILE = stateFile;
  for (const name of ["NOTEES_SERVER", "NOTEES_WORKSPACE", "NOTEES_API_KEY", "NOTEES_EMAIL", "NOTEES_PASSWORD"]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  const { app } = await buildServer({
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
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const server = app.server;
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  const io = new Capture();
  const runCli = async (...args: string[]): Promise<number> => {
    io.stdoutText = "";
    io.stderrText = "";
    // The workspace flag is pinned to the test server's default workspace:
    // a host-stored default (or NOTEES_WORKSPACE env) must not leak into
    // the harness from the developer's real state file.
    return run(["--server", baseUrl, "--key", API_KEY, "--workspace", defaultWorkspaceId(), ...args], io);
  };
  const seedObject = async (name: string, classIds: string[]): Promise<string> => {
    const code = await runCli("object", "create", "--name", name, ...classIds.flatMap((id) => ["--class", id]));
    if (code !== 0) throw new Error(`seedObject ${name} failed: ${io.stderrText}`);
    const id = io.stdoutText.trim().split("\n").pop() ?? "";
    io.stdoutText = "";
    return id;
  };
  const seedProperty = async (objectId: string, schemaId: string, value: unknown): Promise<void> => {
    // One property.set op carries ONE value (the applier validates text
    // schemas as a single string / {nodeId} ref); a multi-valued seed sets
    // each element at its own idx.
    const values = Array.isArray(value) ? value : [value];
    for (const [idx, element] of values.entries()) {
      const code = await runCli("object", "property", "set", objectId, schemaId, JSON.stringify(element), "--idx", String(idx));
      if (code !== 0) throw new Error(`seedProperty failed: ${io.stderrText}`);
      io.stdoutText = "";
    }
  };
  const close = async (): Promise<void> => {
    await app.close();
    server.close();
    delete process.env.NOTEES_STATE_FILE;
    for (const name of Object.keys(savedEnv)) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name]!;
    }
  };
  return { app, server, baseUrl, dataDir, stateFile, runCli, seedObject, seedProperty, close };
}

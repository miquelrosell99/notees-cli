import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { defaultWorkspaceId } from "@notees/server";

import { cslItemFor } from "../src/serve/csl-items.js";
import { openBridgeSession, type BridgeSession } from "../src/serve/session.js";

import { API_KEY, bootServer, type Harness } from "./helpers/serve-harness.js";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

let harness: Harness;
let session: BridgeSession;
let duneId = "";
let articleId = "";
let plainPageId = "";

beforeAll(async () => {
  harness = await bootServer();
  duneId = await harness.seedObject("Dune", [SYSTEM_CLASS_UUIDS.source, SYSTEM_CLASS_UUIDS.book]);
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.citekey, "herbert1965dune");
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.authors, ["Herbert, Frank"]);
  // publicationDate is a DATETIME schema: a bare string is not a lawful
  // value — the point shape { nodeId } references a date node whose title
  // carries the year (cslItemFor resolves the ref through the local store).
  const year1965 = await harness.seedObject("1965", []);
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.publicationDate, { nodeId: year1965 });
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.publisher, "Chilton Books");
  articleId = await harness.seedObject("Sandworms of Note", [
    SYSTEM_CLASS_UUIDS.source,
    SYSTEM_CLASS_UUIDS.journal_article,
  ]);
  await harness.seedProperty(articleId, SYSTEM_PROPERTY_UUIDS.authors, ["Atreides, Paul"]);
  plainPageId = await harness.seedObject("Some plain page", []);
  session = await openBridgeSession({
    server: harness.baseUrl,
    apiKey: API_KEY,
    workspaceId: defaultWorkspaceId(),
    storeDir: join(dirname(harness.stateFile), "stores"),
    statePath: harness.stateFile,
    stateKey: `default:${harness.baseUrl}`,
    syncIntervalMs: 3_600_000,
    onWarning: () => {},
  });
}, 60_000);

afterAll(async () => {
  session?.close();
  await harness?.close();
  rmSync(harness?.dataDir ?? "", { recursive: true, force: true });
});

describe("cslItemFor", () => {
  it("maps a decorated book through nodeToCsl (citekey, authors, year, publisher)", () => {
    const item = cslItemFor(session.local, duneId)!;
    expect(item).toMatchObject({
      id: "herbert1965dune",
      type: "book",
      title: "Dune",
      author: [{ family: "Herbert", given: "Frank" }],
      issued: { "date-parts": [[1965]] },
      publisher: "Chilton Books",
    });
  });

  it("falls back to the node id when the source has no citekey", () => {
    const item = cslItemFor(session.local, articleId)!;
    expect(item.id).toBe(articleId);
    expect(item.type).toBe("article-journal");
  });

  it("returns undefined for non-source nodes and unknown ids", () => {
    expect(cslItemFor(session.local, plainPageId)).toBeUndefined();
    expect(cslItemFor(session.local, "00000000-0000-0000-0000-00000000dead")).toBeUndefined();
  });
});

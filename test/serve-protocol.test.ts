import { describe, expect, it } from "vitest";

import { parseServeRequest, serveError } from "../src/serve/protocol.js";

describe("parseServeRequest", () => {
  it.each([null, undefined, 42, "search", []])("rejects non-object bodies: %j", (body) => {
    const parsed = parseServeRequest(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.error.code).toBe("bad_request");
  });

  it("parses search", () => {
    expect(parseServeRequest({ cmd: "search", query: "dune" })).toEqual({
      ok: true,
      request: { cmd: "search", query: "dune" },
    });
  });

  it("rejects search without a non-empty string query", () => {
    for (const query of [undefined, "", 7]) {
      const parsed = parseServeRequest({ cmd: "search", query });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.response.error.code).toBe("bad_request");
    }
  });

  it("parses render-citation with and without a locator", () => {
    expect(
      parseServeRequest({ cmd: "render-citation", objectIds: ["a", "b"], styleId: "apa" }),
    ).toEqual({ ok: true, request: { cmd: "render-citation", objectIds: ["a", "b"], styleId: "apa" } });
    expect(
      parseServeRequest({ cmd: "render-citation", objectIds: ["a"], styleId: "apa", locator: "23" }),
    ).toEqual({
      ok: true,
      request: { cmd: "render-citation", objectIds: ["a"], styleId: "apa", locator: "23" },
    });
  });

  it("rejects empty/non-string objectIds and missing styleId", () => {
    for (const body of [
      { cmd: "render-citation", objectIds: [], styleId: "apa" },
      { cmd: "render-citation", objectIds: ["a", 3], styleId: "apa" },
      { cmd: "render-bibliography", objectIds: ["a"], styleId: "" },
      { cmd: "render-citation", objectIds: ["a"], styleId: "apa", locator: 5 },
    ]) {
      const parsed = parseServeRequest(body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.response.error.code).toBe("bad_request");
    }
  });

  it("parses list-styles and answers unknown_cmd otherwise", () => {
    expect(parseServeRequest({ cmd: "list-styles" })).toEqual({
      ok: true,
      request: { cmd: "list-styles" },
    });
    const parsed = parseServeRequest({ cmd: "refresh" });
    expect(parsed).toEqual({
      ok: false,
      response: serveError("unknown_cmd", 'unknown cmd "refresh"'),
    });
  });
});

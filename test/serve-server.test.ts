import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveServeConfig } from "../src/serve/config.js";
import { serveError, type ServeRequest, type ServeResponse } from "../src/serve/protocol.js";
import { startBridge, type Bridge } from "../src/serve/server.js";

describe("startBridge", () => {
  let bridge: Bridge | undefined;

  beforeEach(() => {
    bridge = undefined;
  });
  afterEach(async () => {
    await bridge?.close();
  });

  async function post(
    port: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: ServeResponse }> {
    const response = await fetch(`http://127.0.0.1:${port}/document`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as ServeResponse };
  }

  it("binds 127.0.0.1 and answers a tokened POST /document", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    const seen: ServeRequest[] = [];
    bridge = await startBridge(config, {
      dispatch: async (request) => {
        seen.push(request);
        return { ok: true, styles: [] };
      },
    });
    expect(bridge.address).toBe("127.0.0.1");
    const res = await post(bridge.port, { cmd: "list-styles" }, {
      authorization: "Bearer test-token",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, styles: [] });
    expect(seen).toEqual([{ cmd: "list-styles" }]);
  });

  it("rejects a missing or wrong bearer token with 401 and a generic body", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    for (const auth of [undefined, "Bearer wrong", "test-token"]) {
      const res = await post(bridge.port, { cmd: "list-styles" }, auth === undefined ? {} : { authorization: auth });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(serveError("bad_request", "missing or invalid bearer token"));
    }
  });

  it("compares the bearer token in constant time — an equal-length wrong token still 401s", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    // Same length as the real token: the only case a length-early-exit could
    // leak, so the pin rides the equal-length path through timingSafeEqual.
    const res = await post(bridge.port, { cmd: "list-styles" }, {
      authorization: "Bearer test-tokem",
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(serveError("bad_request", "missing or invalid bearer token"));
  });

  it("rejects a disallowed Origin with 403, allows listed ones, and requires Origin when an allowlist exists", async () => {
    const config = resolveServeConfig(
      { port: "0", origin: ["https://word.example"] },
      { NOTEES_SERVE_TOKEN: "test-token" },
    );
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    const headers = { authorization: "Bearer test-token" };

    const blocked = await post(bridge.port, { cmd: "list-styles" }, { ...headers, origin: "https://evil.example" });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual(serveError("bad_request", "origin is not allowed"));

    const allowed = await post(bridge.port, { cmd: "list-styles" }, { ...headers, origin: "https://word.example" });
    expect(allowed.status).toBe(200);

    // With an allowlist in force, an absent Origin is rejected too — only the
    // exact listed values pass. (No allowlist: Origin is simply not checked.)
    const noOrigin = await post(bridge.port, { cmd: "list-styles" }, headers);
    expect(noOrigin.status).toBe(403);
  });

  it("answers CORS preflight: 204 + the three ACAO headers for a listed origin, 403 without ACAO otherwise", async () => {
    const config = resolveServeConfig(
      { port: "0", origin: ["https://word.example"] },
      { NOTEES_SERVE_TOKEN: "test-token" },
    );
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });

    async function preflight(origin: string | undefined): Promise<Response> {
      return fetch(`http://127.0.0.1:${bridge!.port}/document`, {
        method: "OPTIONS",
        headers: origin === undefined ? {} : { origin },
      });
    }

    const ok = await preflight("https://word.example");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://word.example");
    expect(ok.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(ok.headers.get("access-control-allow-headers")).toBe("authorization, content-type");

    for (const bad of ["https://evil.example", undefined] as const) {
      const denied = await preflight(bad);
      expect(denied.status).toBe(403);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    }

    // Fail-closed even with no allowlist configured: no match, no ACAO.
    const open = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    const openBridge = await startBridge(open, { dispatch: async () => ({ ok: true, styles: [] }) });
    const denied = await fetch(`http://127.0.0.1:${openBridge.port}/document`, {
      method: "OPTIONS",
      headers: { origin: "https://word.example" },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    await openBridge.close();
  });

  it("echoes Access-Control-Allow-Origin on POST responses for a matched origin only", async () => {
    const config = resolveServeConfig(
      { port: "0", origin: ["https://word.example"] },
      { NOTEES_SERVE_TOKEN: "test-token" },
    );
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    const headers = { authorization: "Bearer test-token" };

    const res = await fetch(`http://127.0.0.1:${bridge.port}/document`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers, origin: "https://word.example" },
      body: JSON.stringify({ cmd: "list-styles" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://word.example");
    await res.json();

    // The disallowed POST still 403s through the origin gate — and carries no
    // ACAO, so the browser hides the body cross-origin too.
    const denied = await fetch(`http://127.0.0.1:${bridge.port}/document`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers, origin: "https://evil.example" },
      body: JSON.stringify({ cmd: "list-styles" }),
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    await denied.json();
  });

  it("answers 404 for wrong paths and methods", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    for (const [method, path] of [["POST", "/other"], ["GET", "/document"], ["PUT", "/document"]] as const) {
      const res = await fetch(`http://127.0.0.1:${bridge.port}${path}`, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(serveError("bad_request", "POST /document only"));
    }
  });

  it("rejects non-JSON bodies with 400 and oversized bodies with 413", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };

    const notJson = await post(bridge.port, "{not json", headers);
    expect(notJson.status).toBe(400);
    expect(notJson.body).toEqual(serveError("bad_request", "body is not valid JSON"));

    const huge = await post(bridge.port, JSON.stringify({ cmd: "search", query: "x".repeat(1_100_000) }), headers);
    expect(huge.status).toBe(413);
    expect(huge.body).toEqual(serveError("bad_request", "request body too large (max 1 MB)"));
  });

  it("maps command error envelopes to their HTTP statuses", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, {
      dispatch: async (request) =>
        request.cmd === "search"
          ? serveError("unknown_cmd", "unknown cmd")
          : serveError("not_found", "gone"),
    });
    const headers = { authorization: "Bearer test-token" };
    expect((await post(bridge.port, { cmd: "search", query: "x" }, headers)).status).toBe(400);
    expect((await post(bridge.port, { cmd: "list-styles" }, headers)).status).toBe(404);
  });

  it("survives a throwing dispatch (500, generic body, keeps answering)", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, {
      dispatch: async () => {
        throw new Error("boom");
      },
    });
    const res = await post(bridge.port, { cmd: "list-styles" }, { authorization: "Bearer test-token" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual(serveError("bad_request", "internal error"));
    // And the next request still works — the throw never reaches the socket.
    const again = await post(bridge.port, { cmd: "list-styles" }, { authorization: "Bearer test-token" });
    expect(again.status).toBe(500); // still the throwing stub — but answered, not crashed
  });

  it("close() drains in-flight requests before resolving", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    let release: (() => void) | undefined;
    bridge = await startBridge(config, {
      dispatch: () =>
        new Promise<ServeResponse>((resolve) => {
          release = () => resolve({ ok: true, styles: [] });
        }),
    });
    const pending = post(bridge.port, { cmd: "list-styles" }, { authorization: "Bearer test-token" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = bridge.close();
    release?.();
    await closed;
    expect((await pending).status).toBe(200);
    // Port is free again: a new connection is refused.
    await expect(
      fetch(`http://127.0.0.1:${bridge.port}/document`, { method: "POST" }),
    ).rejects.toThrow();
  });
});

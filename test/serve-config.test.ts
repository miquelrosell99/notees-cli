import { describe, expect, it } from "vitest";

import { resolveServeConfig } from "../src/serve/config.js";
import { EXIT } from "../src/exit-codes.js";

describe("resolveServeConfig", () => {
  it("applies the defaults: loopback host, port 8474, 60s sync interval, generated token", () => {
    const config = resolveServeConfig({}, {});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8474);
    expect(config.origins).toEqual([]);
    expect(config.syncIntervalMs).toBe(60_000);
    expect(config.token.length).toBeGreaterThanOrEqual(32);
  });

  it("honors NOTEES_SERVE_TOKEN over a generated token", () => {
    const config = resolveServeConfig({}, { NOTEES_SERVE_TOKEN: "pinned-token" });
    expect(config.token).toBe("pinned-token");
  });

  it("collects --origin repeats and carries the optional paths", () => {
    const config = resolveServeConfig({
      origin: ["https://word.example", "https://word2.example"],
      tokenFile: "/tmp/token",
      stylesDir: "/tmp/styles",
      syncInterval: "30",
      port: "9000",
    }, {});
    expect(config.origins).toEqual(["https://word.example", "https://word2.example"]);
    expect(config.tokenFile).toBe("/tmp/token");
    expect(config.stylesDir).toBe("/tmp/styles");
    expect(config.syncIntervalMs).toBe(30_000);
    expect(config.port).toBe(9000);
  });

  it.each(["-1", "65536", "abc", "1.5"])(
    "rejects --port %s with the usage exit code",
    (port) => {
      let caught: unknown;
      try {
        resolveServeConfig({ port }, {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ exitCode: EXIT.usage });
    },
  );

  it("rejects a sub-5-second sync interval", () => {
    expect(() => resolveServeConfig({ syncInterval: "2" }, {})).toThrowError(
      expect.objectContaining({ exitCode: EXIT.usage }),
    );
  });
});

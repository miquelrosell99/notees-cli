import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildStylesModule } from "../scripts/bundle-styles.mts";
import { BUNDLED_STYLES, listStyles, localeXml, resolveStyleXml } from "../src/serve/styles.js";

const stylesDir = fileURLToPath(new URL("../src/serve/styles/", import.meta.url));

describe("bundled styles", () => {
  it("bundles exactly apa, ieee, chicago-note-bibliography and the en-US locale", () => {
    expect(BUNDLED_STYLES.map((s) => s.id)).toEqual(["apa", "ieee", "chicago-note-bibliography"]);
    expect(localeXml("locales-en-US")).toContain("<locale");
    expect(localeXml("fr-FR")).toBeUndefined();
  });

  it("generated.ts matches the canonical .csl files (drift gate)", () => {
    const generated = readFileSync(join(stylesDir, "generated.ts"), "utf8");
    expect(buildStylesModule(stylesDir)).toBe(generated);
  });

  it("resolves bundled styles and rejects malformed ids without touching the fs", () => {
    expect(resolveStyleXml("apa")).toContain("<style");
    expect(resolveStyleXml("../../etc/passwd")).toBeUndefined();
    expect(resolveStyleXml("no-such-style")).toBeUndefined();
  });

  it("lists user-supplied .csl from --styles-dir after the bundled ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-styles-"));
    writeFileSync(join(dir, "my-style.csl"), "<style xmlns='http://purl.org/net/xbiblio/csl'/>");
    const styles = listStyles(dir);
    expect(styles.map((s) => s.id)).toEqual(["apa", "ieee", "chicago-note-bibliography", "my-style"]);
  });
});

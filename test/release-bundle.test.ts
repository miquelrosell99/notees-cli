import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";

import { describe, expect, it } from "vitest";

// The release bundle must be standalone: scripts/install.sh ships
// dist/cli.js (as cli.mjs) with no node_modules beside it, so tsup must
// compile every runtime dependency in (noExternal). A bare import left in
// the bundle only blows up on the install target with
// ERR_MODULE_NOT_FOUND — this test fails at gate time instead.
// (Regression: sax was external in the v4.5.3 bundle and crashed every
// install.sh / pacman install at startup.)

const BUNDLE_URL = new URL("../dist/cli.js", import.meta.url);

function bareSpecifiers(source: string): string[] {
  // Keyword-position import forms only — the lookbehind rejects method calls
  // like Array.from("…") that a plain scan of minified code would false-positive on.
  const patterns = [
    /(?<![.\w$])from\s*["']([^"']+)["']/g,
    /(?<![.\w$])import\s*["']([^"']+)["']/g,
    /(?<![.\w$])require\(\s*["']([^"']+)["']\s*\)/g,
  ];
  // A real bare specifier is a package name; template-literal remnants inside
  // minified strings ("${s.name}") are not.
  const BARE_PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
  const specs = new Set<string>();
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const spec = m[1];
      if (spec === undefined) continue;
      if (!BARE_PACKAGE.test(spec)) continue;
      if (!spec.startsWith(".") && !spec.startsWith("/")) specs.add(spec);
    }
  }
  return [...specs];
}

describe("release bundle", () => {
  it("has no bare imports outside node builtins (standalone)", () => {
    let source: string;
    try {
      source = readFileSync(BUNDLE_URL, "utf8");
    } catch {
      throw new Error("dist/cli.js missing — run `pnpm build` before the test gate");
    }
    const external = bareSpecifiers(source).filter((s) => !isBuiltin(s));
    expect(external).toEqual([]);
  });
});

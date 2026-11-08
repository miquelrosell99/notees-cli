import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CslItem } from "@notees/export";

import { createCiteRenderer } from "../src/serve/cite.js";

const ITEM: CslItem = {
  id: "doe2020test",
  type: "book",
  title: "The Test Book",
  author: [{ family: "Doe", given: "Jane" }],
  issued: { "date-parts": [[2020]] },
};

describe("createCiteRenderer", () => {
  it("renders an apa in-text citation", () => {
    const out = createCiteRenderer().renderCitation([ITEM], "apa");
    expect(typeof out).toBe("string");
    expect(out as string).toContain("Doe");
    expect(out as string).toContain("2020");
  });

  it("includes the locator when given", () => {
    const out = createCiteRenderer().renderCitation([ITEM], "apa", "23") as string;
    expect(out).toContain("23");
  });

  it("renders an apa bibliography entry", () => {
    const out = createCiteRenderer().renderBibliography([ITEM], "apa") as string;
    expect(out).toContain("Doe, J.");
    expect(out).toContain("The Test Book");
  });

  it("answers not_found for an unknown style id", () => {
    expect(createCiteRenderer().renderBibliography([ITEM], "no-such-style")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("answers render_failed when citeproc throws (corrupt user style)", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-styles-"));
    writeFileSync(join(dir, "broken.csl"), "<style>not valid csl</style>");
    const out = createCiteRenderer(dir).renderBibliography([ITEM], "broken");
    expect(out).toMatchObject({ ok: false, error: { code: "render_failed" } });
    // …and the renderer stays usable afterwards (per-request engine).
    expect(createCiteRenderer().renderBibliography([ITEM], "apa")).not.toMatchObject({ ok: false });
  });
});

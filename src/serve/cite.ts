import { createRequire } from "node:module";

import type { CslItem } from "@notees/export";

import { serveError, type ServeErrorBody } from "./protocol.js";
import { localeXml, resolveStyleXml } from "./styles.js";

// citeproc-js is CommonJS and ships no ESM entry; the release bundle's
// createRequire banner (tsup.config.ts) and Node's native createRequire
// both serve this equally. citeproc-js parses CSL XML through the DOM
// parser it finds in the environment — browsers have one, Node does not,
// so the bridge installs xmldom's as a global before the first Engine.
import { DOMParser as XmldomParser } from "@xmldom/xmldom";

const globalScope = globalThis as { DOMParser?: unknown };
if (globalScope.DOMParser === undefined) {
  globalScope.DOMParser = XmldomParser;
}

const require = createRequire(import.meta.url);
const { Engine } = require("citeproc") as typeof import("citeproc");

export interface CiteRenderer {
  /** Raw citeproc cluster string — light markup (<i>, <b>) included. */
  renderCitation(items: CslItem[], styleId: string, locator?: string): string | ServeErrorBody;
  /** Raw citeproc bibliography entries, newline-joined. */
  renderBibliography(items: CslItem[], styleId: string): string | ServeErrorBody;
}

export function createCiteRenderer(stylesDir?: string): CiteRenderer {
  /**
   * One engine per render: engines carry mutable registry state
   * (updateItems/appendCitationCluster), so sharing one across requests —
   * or across concurrent requests — would leak state between documents.
   * A failing engine dies with its request: render_failed, bridge unaffected.
   */
  function withEngine<T>(styleId: string, items: CslItem[], render: (engine: InstanceType<typeof Engine>) => T): string | ServeErrorBody | T {
    const xml = resolveStyleXml(styleId, stylesDir);
    if (xml === undefined) return serveError("not_found", `unknown style "${styleId}"`);
    try {
      const byId = new Map(items.map((item) => [item.id, item]));
      const engine = new Engine(
        {
          // citeproc asks for bare language tags ("en-US"); the bundled
          // locale files keep their upstream "locales-" filename prefix as
          // map keys, so the lookup falls back to the prefixed key.
          retrieveLocale: (lang: string): string | undefined =>
            localeXml(lang) ?? localeXml(`locales-${lang}`),
          retrieveItem: (id: string): unknown => byId.get(id),
        },
        xml,
        "en-US",
      );
      return render(engine);
    } catch (error) {
      return serveError("render_failed", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    renderCitation(items, styleId, locator) {
      return withEngine(styleId, items, (engine) => {
        const clusters = engine.appendCitationCluster(
          {
            citationItems: items.map((item) => ({
              id: item.id,
              ...(locator !== undefined && locator.length > 0 ? { locator, label: "page" } : {}),
            })),
            properties: {},
          },
          true,
        );
        // One [position, text, citationId] entry per citation in the cluster.
        return clusters.map(([, text]) => text).join("");
      });
    },
    renderBibliography(items, styleId) {
      return withEngine(styleId, items, (engine) => {
        engine.updateItems(items.map((item) => item.id));
        const [, entries] = engine.makeBibliography();
        return entries.join("\n");
      });
    },
  };
}

import type { CslItem } from "@notees/export";

import type { CiteRenderer } from "./cite.js";
import { cslItemFor } from "./csl-items.js";
import type { BridgeSession } from "./session.js";
import { serveError, type ServeRequest, type ServeResponse } from "./protocol.js";
import { listStyles } from "./styles.js";

export interface DocumentContext {
  session: BridgeSession;
  renderer: CiteRenderer;
  /** --styles-dir: user-supplied .csl directory, scanned after the bundled styles. */
  stylesDir?: string;
}

/**
 * The /document command dispatcher. Every arm is live over the bridge
 * session; dispatch NEVER throws — every failure is an error envelope (the
 * server turns unexpected throws into bad_request).
 */
export async function dispatchDocument(
  context: DocumentContext,
  request: ServeRequest,
): Promise<ServeResponse> {
  switch (request.cmd) {
    case "search":
      return { ok: true, results: context.session.searchSources(request.query) };
    case "list-styles":
      return { ok: true, styles: listStyles(context.stylesDir) };
    case "render-citation":
    case "render-bibliography": {
      const items: CslItem[] = [];
      for (const id of request.objectIds) {
        const item = cslItemFor(context.session.local, id);
        // Missing id OR a node that is not a source — both are not_found so the
        // add-in can tell "bad id" from "render broke".
        if (item === undefined) return serveError("not_found", `no source object ${id}`);
        items.push(item);
      }
      if (request.cmd === "render-citation") {
        const citation = context.renderer.renderCitation(items, request.styleId, request.locator);
        return typeof citation === "string" ? { ok: true, citation } : citation;
      }
      const bibliography = context.renderer.renderBibliography(items, request.styleId);
      return typeof bibliography === "string" ? { ok: true, bibliography } : bibliography;
    }
  }
}

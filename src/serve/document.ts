import type { CiteRenderer } from "./cite.js";
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
 * The /document command dispatcher. The search and list-styles arms are
 * live over the bridge session; render arms answer not_found until the
 * render slice lands; dispatch NEVER throws — every failure is an error
 * envelope (the server turns unexpected throws into bad_request).
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
    case "render-bibliography":
      // Tasks 5+6 land cslItemFor/renderer; until then render arms answer
      // not_found for any id — never a thrown exception.
      return serveError("not_found", "render commands land with the citeproc slice");
  }
}

import type { CiteRenderer } from "./cite.js";
import type { BridgeSession } from "./session.js";
import { serveError, type ServeRequest, type ServeResponse } from "./protocol.js";

export interface DocumentContext {
  session: BridgeSession;
  renderer: CiteRenderer;
}

/**
 * The /document command dispatcher. The search arm is live over the bridge
 * session; render arms answer not_found until the citeproc slice lands;
 * dispatch NEVER throws — every failure is an error envelope (the server
 * turns unexpected throws into bad_request).
 */
export async function dispatchDocument(
  context: DocumentContext,
  request: ServeRequest,
): Promise<ServeResponse> {
  switch (request.cmd) {
    case "search":
      return { ok: true, results: context.session.searchSources(request.query) };
    case "list-styles":
      // The styles slice lands with citeproc (the styles-dir scan +
      // listStyles live there); until then the arm answers not_found —
      // never a thrown exception, never a fake empty catalog.
      return serveError("not_found", "list-styles lands with the citeproc slice");
    case "render-citation":
    case "render-bibliography":
      // Tasks 5+6 land cslItemFor/renderer; until then render arms answer
      // not_found for any id — never a thrown exception.
      return serveError("not_found", "render commands land with the citeproc slice");
  }
}

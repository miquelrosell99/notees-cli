import type { CslItem } from "@notees/export";

import { serveError, type ServeErrorBody } from "./protocol.js";

export interface CiteRenderer {
  /** Raw citeproc cluster string — light markup (<i>, <b>) included. */
  renderCitation(items: CslItem[], styleId: string, locator?: string): string | ServeErrorBody;
  /** Raw citeproc bibliography entries, newline-joined. */
  renderBibliography(items: CslItem[], styleId: string): string | ServeErrorBody;
}

/** Stub until the citeproc slice (Task 6): renders fail loud, never throw. */
export function createCiteRenderer(_stylesDir?: string): CiteRenderer {
  const notWired = () => serveError("render_failed", "citation rendering lands with the citeproc slice");
  return { renderCitation: notWired, renderBibliography: notWired };
}

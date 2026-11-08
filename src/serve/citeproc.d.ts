/**
 * Minimal ambient surface of the `citeproc` package (citeproc-js ships no
 * TypeScript types). Only what the bridge uses is declared.
 */
declare module "citeproc" {
  export interface CitationItem {
    id: string;
    locator?: string;
    label?: string;
  }
  export class Engine {
    constructor(
      sys: {
        retrieveLocale(lang: string): string | undefined;
        retrieveItem(id: string): unknown;
      },
      styleXml: string,
      lang?: string,
    );
    updateItems(ids: string[]): void;
    /** Returns [[position, renderedText, citationId], …] for the appended cluster. */
    appendCitationCluster(
      citation: { citationItems: CitationItem[]; properties: Record<string, unknown> },
      forceSort?: boolean,
    ): Array<[number, string, string]>;
    /** Returns [meta, renderedEntries]. */
    makeBibliography(): [Record<string, unknown>, string[]];
  }
}

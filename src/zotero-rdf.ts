/**
 * Zotero RDF import — the streaming parser behind `notees import zotero-rdf`.
 *
 * Shape (learned from a real 4.7MB Zotero export):
 *   - Top-level children of `rdf:RDF`: `bib:*` elements are entries
 *     (bib:Book, bib:Article, bib:Legislation, …); `z:Attachment` and anything
 *     else is skipped wholesale.
 *   - A field value is captured ONLY when its DIRECT parent is the entry
 *     element — the classic trap is `<dcterms:isPartOf><bib:Journal>` nesting
 *     a journal with its OWN `dc:title` inside an article; the article's real
 *     title is the direct-child `dc:title`.
 *   - `bib:Authors` (capital A) → `rdf:Seq` → `rdf:li` → `foaf:Person` with
 *     `foaf:surname` / `foaf:givenName` children.
 *
 * sax matches prefixed tag names literally (no namespace resolution), decodes
 * entities, and may deliver character data in chunks — this module tracks the
 * element stack and accumulates leaf text.
 */

import sax from "sax";

import { type CslItem, type CslName, type CslType } from "@notees/export";

export interface ZoteroRdfParseResult {
  items: CslItem[];
  /** Top-level `bib:*` entries WITHOUT a z:citationKey (e.g. journals) — skipped. */
  skipped: number;
}

interface DraftEntry {
  citekey?: string;
  itemType?: string;
  title?: string;
  date?: string;
  isbn?: string;
  doi?: string;
  authors: CslName[];
}

/** z:itemType value → CSL type (best-effort; the fallback class for anything
 *  unmapped is `document`, same as the bibtex importer's default). */
const ITEM_TYPE_TO_CSL: Record<string, CslType> = {
  book: "book",
  journalArticle: "article-journal",
  magazineArticle: "article-journal",
  newspaperArticle: "article-journal",
  conferencePaper: "paper-conference",
  thesis: "thesis",
  dissertation: "thesis",
  report: "report",
  statute: "report",
  patent: "report",
  webpage: "report",
  document: "report",
  bill: "report",
  standard: "report",
};

/** Fallback when z:itemType is absent: the bib element name itself
 * (bib:Book → book, …; anything else → report → the document class). */
const BIB_TAG_TO_CSL: Record<string, CslType> = {
  book: "book",
  article: "article-journal",
  journal: "article-journal",
  conferencepaper: "paper-conference",
  thesis: "thesis",
  dissertation: "thesis",
};

const textOf = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

/** First 4-digit year of a date-ish string (publicationDate is year-only). */
function yearOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /(\d{4})/.exec(value);
  return match === null ? undefined : Number.parseInt(match[1]!, 10);
}

/** Best-effort extraction from dc:identifier text ("ISBN 978…", "DOI: 10.…"). */
function identifierOf(kind: "ISBN" | "DOI", value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = new RegExp(`${kind}\\s*[:#]?\\s*([^\\s;,]+)`, "i").exec(value);
  return match === null ? undefined : match[1];
}

function entryToCsl(entryTag: string, draft: DraftEntry): CslItem {
  const fromItemType = draft.itemType !== undefined ? ITEM_TYPE_TO_CSL[draft.itemType] : undefined;
  const fromTag = BIB_TAG_TO_CSL[entryTag.replace(/^bib:/i, "").toLowerCase()];
  const title = textOf(draft.title);
  const item: CslItem = {
    id: draft.citekey!,
    type: fromItemType ?? fromTag ?? "report",
    ...(title !== undefined ? { title } : {}),
    ...(draft.authors.length > 0 ? { author: draft.authors } : {}),
  };
  const year = yearOf(draft.date);
  if (year !== undefined) item.issued = { "date-parts": [[year]] };
  const isbn = identifierOf("ISBN", draft.isbn);
  if (isbn !== undefined) item.ISBN = isbn;
  const doi = identifierOf("DOI", draft.doi);
  if (doi !== undefined) item.DOI = doi;
  return item;
}

export function parseZoteroRdf(text: string): ZoteroRdfParseResult {
  const parser = sax.parser(true, { trim: false, normalize: false });
  const items: CslItem[] = [];
  let skipped = 0;

  const tagStack: string[] = [];
  // The entry element currently open (null between entries).
  let entry: DraftEntry | null = null;
  let entryTag: string | null = null;
  let entryDepth = -1;
  // Leaf accumulator: which field the arriving character data belongs to.
  let textTarget: { tag: string; field: "citekey" | "itemType" | "title" | "date" | "identifier" | "surname" | "givenName" | "orgName" } | null = null;
  let textBuffer = "";
  // Author parsing state (Zotero exports use both `bib:Authors` and the
  // lowercase `bib:authors`; author entries are foaf:Person with
  // surname/givenName or, for organizations, foaf:Organization with a name).
  let authorsDepth = -1;
  let person: CslName | null = null;
  let personIsOrg = false;

  const commitText = (): void => {
    if (textTarget === null) return;
    const value = textBuffer.trim();
    if (entry !== null && value.length > 0) {
      switch (textTarget.field) {
        case "citekey":
          entry.citekey = value;
          break;
        case "itemType":
          entry.itemType = value;
          break;
        case "title":
          entry.title = value;
          break;
        case "date":
          entry.date = value;
          break;
        case "identifier":
          if (/ISBN/i.test(value)) entry.isbn = value;
          else if (/DOI/i.test(value)) entry.doi = value;
          break;
        case "surname":
          if (person !== null) person.family = value;
          break;
        case "givenName":
          if (person !== null) person.given = value;
          break;
        case "orgName":
          if (person !== null) person.literal = value;
          break;
      }
    }
    textTarget = null;
    textBuffer = "";
  };

  parser.onopentag = (node) => {
    const tag: string = node.name;
    const parent = tagStack[tagStack.length - 1] ?? null;
    // Entry elements are DIRECT children of rdf:RDF and bib:*.
    if (parent === "rdf:RDF") {
      if (tag.startsWith("bib:")) {
        entry = { authors: [] };
        entryTag = tag;
        entryDepth = tagStack.length; // index of the entry element once pushed
        tagStack.push(tag);
        return;
      }
      // z:Attachment and friends: skip the whole subtree (no entry opened —
      // nothing below is captured because `entry` stays null).
      tagStack.push(tag);
      return;
    }
    if (entry !== null) {
      // Direct-child fields of the entry element.
      if (parent === entryTag && tagStack.length === entryDepth + 1) {
        if (tag === "z:citationKey") textTarget = { tag, field: "citekey" };
        else if (tag === "z:itemType") textTarget = { tag, field: "itemType" };
        else if (tag === "dc:title") textTarget = { tag, field: "title" };
        else if (tag === "dc:date") textTarget = { tag, field: "date" };
        else if (tag === "dc:identifier") textTarget = { tag, field: "identifier" };
        else if (tag === "bib:Authors" || tag === "bib:authors") authorsDepth = tagStack.length;
      }
      // Author list: bib:Authors → rdf:Seq → rdf:li → foaf:Person.
      if (authorsDepth !== -1 && (tag === "foaf:Person" || tag === "foaf:Organization")) {
        person = {};
        personIsOrg = tag === "foaf:Organization";
      }
      if (person !== null && !personIsOrg && (tag === "foaf:surname" || tag === "foaf:givenName")) {
        textTarget = { tag, field: tag === "foaf:surname" ? "surname" : "givenName" };
      }
      if (person !== null && personIsOrg && tag === "foaf:name") {
        textTarget = { tag, field: "orgName" };
      }
    }
    tagStack.push(tag);
  };

  parser.ontext = (raw) => {
    if (textTarget !== null) textBuffer += typeof raw === "string" ? raw : String(raw);
  };

  parser.oncdata = (raw) => {
    if (textTarget !== null) textBuffer += String(raw);
  };

  parser.onclosetag = (node) => {
    const tag: string = node;
    commitText();
    if (person !== null && (tag === "foaf:Person" || tag === "foaf:Organization")) {
      if (entry !== null) entry.authors.push(person);
      person = null;
      personIsOrg = false;
    }
    if (tag === "bib:Authors" || tag === "bib:authors") authorsDepth = -1;
    if (entry !== null && tag === entryTag && tagStack.length - 1 === entryDepth) {
      // Entry closes: only keyed entries become items (journals etc. count
      // as skipped).
      if (entry.citekey !== undefined && entry.citekey.trim().length > 0) {
        items.push(entryToCsl(entryTag!, entry));
      } else {
        skipped += 1;
      }
      entry = null;
      entryTag = null;
      entryDepth = -1;
      authorsDepth = -1;
      person = null;
      personIsOrg = false;
    }
    tagStack.pop();
  };

  // Well-formed input is the contract (Zotero exports); a parse failure is
  // recorded and re-thrown once the (synchronous) write finishes.
  let parseError: Error | null = null;
  parser.onerror = (error) => {
    if (parseError === null) parseError = error;
    try {
      parser.resume();
    } catch {
      // Recorded above — re-thrown after write() returns.
    }
  };

  parser.write(text).close();
  if (parseError !== null) throw parseError;
  return { items, skipped };
}

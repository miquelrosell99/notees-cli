/**
 * Zotero RDF import — the streaming parser behind `notees import zotero-rdf`.
 *
 * Shape (learned from a real 4.7MB Zotero export):
 *   - Top-level children of `rdf:RDF`: `bib:*` elements are entries
 *     (bib:Book, bib:Article, bib:Legislation, …); `z:Attachment` and anything
 *     else is skipped wholesale (attachments are counted for the report).
 *   - A field value is captured ONLY when its DIRECT parent is the entry
 *     element — the classic trap is `<dcterms:isPartOf><bib:Journal>` nesting
 *     a journal with its OWN `dc:title` inside an article; the article's real
 *     title is the direct-child `dc:title`. The nested container's title is
 *     captured separately (the container-title fill).
 *   - `bib:Authors` (capital A) and `bib:editors` → `rdf:Seq` → `rdf:li` →
 *     `foaf:Person` with `foaf:surname` / `foaf:givenName` children (or a
 *     `foaf:Organization` with `foaf:name`).
 *   - `dc:publisher` nests `foaf:Organization`/`foaf:name`; several publishers
 *     join with "; ".
 *
 * Field mapping beyond the CSL core (dcterms:abstract, prism:volume,
 * prism:number, bib:pages, z:language, dcterms:alternative, dc:description,
 * z:PMID, unclassified dc:identifier prefixes) rides on {@link ZoteroItem} —
 * the CLI's fill step turns those into schema values. `dc:subject` (Zotero
 * tags) is counted but never mapped: class tags are a different semantics.
 *
 * sax matches prefixed tag names literally (no namespace resolution), decodes
 * entities, and may deliver character data in chunks — this module tracks the
 * element stack and accumulates leaf text.
 */

import sax from "sax";

import { ZOTERO_ITEM_TYPE_TO_CLASS } from "@notees/domain";
import {
  CLASS_NAME_TO_CSL_TYPE,
  type CslItem,
  type CslName,
  type CslType,
  type SourceClassName,
} from "@notees/export";

/** The parse output: a CSL item plus the Zotero-specific fields the CLI fills. */
export interface ZoteroItem extends CslItem {
  abstract?: string;
  language?: string;
  shortTitle?: string;
  extra?: string;
  /** Unclassified dc:identifier values + z:PMID ("PMID: …") → the Identifier schema. */
  identifiers?: string[];
}

export interface ZoteroRdfParseResult {
  items: ZoteroItem[];
  /** Top-level `bib:*` entries WITHOUT a z:citationKey (e.g. journals) — skipped. */
  skipped: number;
  /** The keyless entries, listed (rdf:about id + title) — idempotency needs the stable key. */
  keylessSkipped: Array<{ id: string; title: string }>;
  /** `dc:subject` tags seen but never mapped (class tags are a different semantics). */
  tagsSkipped: number;
  /** `z:Attachment` items + `link:link` attachment entries skipped wholesale. */
  attachmentsSkipped: number;
}

/** The leaf fields the entry-level character data can belong to. */
type LeafField =
  | "citekey"
  | "itemType"
  | "title"
  | "date"
  | "identifier"
  | "abstract"
  | "language"
  | "shortTitle"
  | "extra"
  | "uri"
  | "pmid"
  | "volume"
  | "issue"
  | "pages"
  | "subject"
  | "publisherName"
  | "containerTitle"
  | "surname"
  | "givenName"
  | "orgName";

interface DraftEntry {
  aboutId: string;
  citekey?: string;
  itemType?: string;
  title?: string;
  date?: string;
  isbn?: string;
  issn?: string;
  doi?: string;
  identifiers: string[];
  abstract?: string;
  language?: string;
  shortTitle?: string;
  extra?: string;
  uri?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  tags: number;
  publishers: string[];
  authors: CslName[];
  editors: CslName[];
  containerTitle?: string;
}

/** Fallback when z:itemType is absent: the bib element name itself
 * (bib:Book → book, …; anything else → report → the report class). */
const BIB_TAG_TO_CSL: Record<string, CslType> = {
  book: "book",
  article: "article-journal",
  journal: "article-journal",
  conferencepaper: "paper-conference",
  thesis: "thesis",
  dissertation: "thesis",
};

/** z:itemType → CSL type via the vendored Zotero manifest (the item type maps
 *  to a source class, the class maps to its CSL type — magazineArticle lands
 *  on magazine_article → article-magazine, etc.). Unknown → the report
 *  fallback (the best-effort class for unmapped imports). */
function itemTypeToCsl(itemType: string | undefined, entryTag: string): CslType {
  if (itemType !== undefined) {
    const className = (ZOTERO_ITEM_TYPE_TO_CLASS as Record<string, SourceClassName>)[itemType];
    if (className !== undefined) return CLASS_NAME_TO_CSL_TYPE[className];
  }
  return BIB_TAG_TO_CSL[entryTag.replace(/^bib:/i, "").toLowerCase()] ?? "report";
}

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
function identifierOf(kind: "ISBN" | "ISSN" | "DOI", value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = new RegExp(`${kind}\\s*[:#]?\\s*([^\\s;,]+)`, "i").exec(value);
  return match === null ? undefined : match[1];
}

/** dc:identifier classification by prefix: isbn:/issn:/doi: (or the textual
 *  "ISBN …" / "DOI …" forms) land on their schemas; pmid:/arxiv:/anything
 *  else lands on the Identifier schema verbatim. */
function commitIdentifier(entry: DraftEntry, value: string): void {
  const lower = value.toLowerCase();
  if (lower.startsWith("isbn")) {
    entry.isbn = identifierOf("ISBN", value) ?? value;
  } else if (lower.startsWith("doi")) {
    entry.doi = identifierOf("DOI", value) ?? value;
  } else if (lower.startsWith("issn")) {
    entry.issn = identifierOf("ISSN", value) ?? value;
  } else {
    entry.identifiers.push(value);
  }
}

function entryToCsl(entryTag: string, draft: DraftEntry): ZoteroItem {
  const title = textOf(draft.title);
  const item: ZoteroItem = {
    id: draft.citekey!,
    type: itemTypeToCsl(draft.itemType, entryTag),
    ...(title !== undefined ? { title } : {}),
    ...(draft.authors.length > 0 ? { author: draft.authors } : {}),
    ...(draft.editors.length > 0 ? { editor: draft.editors } : {}),
  };
  const year = yearOf(draft.date);
  if (year !== undefined) item.issued = { "date-parts": [[year]] };
  if (draft.isbn !== undefined) item.ISBN = draft.isbn;
  if (draft.issn !== undefined) item.ISSN = draft.issn;
  if (draft.doi !== undefined) item.DOI = draft.doi;
  if (draft.uri !== undefined) item.URL = draft.uri;
  if (draft.volume !== undefined) item.volume = draft.volume;
  if (draft.issue !== undefined) item.issue = draft.issue;
  if (draft.pages !== undefined) item.page = draft.pages;
  if (draft.publishers.length > 0) item.publisher = draft.publishers.join("; ");
  if (draft.containerTitle !== undefined) item["container-title"] = draft.containerTitle;
  if (draft.abstract !== undefined) item.abstract = draft.abstract;
  if (draft.language !== undefined) item.language = draft.language;
  if (draft.shortTitle !== undefined) item.shortTitle = draft.shortTitle;
  if (draft.extra !== undefined) item.extra = draft.extra;
  if (draft.identifiers.length > 0) item.identifiers = draft.identifiers;
  return item;
}

export function parseZoteroRdf(text: string): ZoteroRdfParseResult {
  const parser = sax.parser(true, { trim: false, normalize: false });
  const items: ZoteroItem[] = [];
  let skipped = 0;
  const keylessSkipped: Array<{ id: string; title: string }> = [];
  let tagsSkipped = 0;
  let attachmentsSkipped = 0;

  const tagStack: string[] = [];
  // The entry element currently open (null between entries).
  let entry: DraftEntry | null = null;
  let entryTag: string | null = null;
  let entryDepth = -1;
  // Leaf accumulator: which field the arriving character data belongs to.
  let textTarget: { tag: string; field: LeafField } | null = null;
  let textBuffer = "";
  // Author/editor list parsing state (Zotero exports use `bib:Authors` and the
  // lowercase `bib:authors`/`bib:editors`; entries are foaf:Person with
  // surname/givenName or, for organizations, foaf:Organization with a name).
  let authorsDepth = -1;
  let editorsDepth = -1;
  let person: CslName | null = null;
  let personIsOrg = false;
  // dcterms:isPartOf container tracking: the nested bib:* (Journal/Book/…)
  // element and its dc:title (the container-title fill).
  let partOfDepth = -1;

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
          commitIdentifier(entry, value);
          break;
        case "abstract":
          entry.abstract = value;
          break;
        case "language":
          entry.language = value;
          break;
        case "shortTitle":
          entry.shortTitle = value;
          break;
        case "extra":
          entry.extra = value;
          break;
        case "uri":
          entry.uri = value;
          break;
        case "pmid":
          entry.identifiers.push(`PMID: ${value}`);
          break;
        case "volume":
          entry.volume = value;
          break;
        case "issue":
          entry.issue = value;
          break;
        case "pages":
          entry.pages = value;
          break;
        case "subject":
          entry.tags += 1;
          break;
        case "publisherName":
          entry.publishers.push(value);
          break;
        case "containerTitle":
          entry.containerTitle = value;
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
        entry = { aboutId: String(node.attributes["rdf:about"] ?? ""), authors: [], editors: [], identifiers: [], publishers: [], tags: 0 };
        entryTag = tag;
        entryDepth = tagStack.length; // index of the entry element once pushed
        tagStack.push(tag);
        return;
      }
      if (tag === "z:Attachment") attachmentsSkipped += 1;
      // z:Attachment and friends: skip the whole subtree (no entry opened —
      // nothing below is captured because `entry` stays null).
      tagStack.push(tag);
      return;
    }
    if (entry !== null) {
      // link:link attachment references inside an entry: counted, not mapped.
      if (tag === "link:link") attachmentsSkipped += 1;
      // Direct-child fields of the entry element.
      if (parent === entryTag && tagStack.length === entryDepth + 1) {
        if (tag === "z:citationKey") textTarget = { tag, field: "citekey" };
        else if (tag === "z:itemType") textTarget = { tag, field: "itemType" };
        else if (tag === "dc:title") textTarget = { tag, field: "title" };
        else if (tag === "dc:date") textTarget = { tag, field: "date" };
        else if (tag === "dc:identifier") textTarget = { tag, field: "identifier" };
        else if (tag === "dcterms:abstract") textTarget = { tag, field: "abstract" };
        else if (tag === "z:language") textTarget = { tag, field: "language" };
        else if (tag === "dcterms:alternative") textTarget = { tag, field: "shortTitle" };
        else if (tag === "dc:description") textTarget = { tag, field: "extra" };
        else if (tag === "dcterms:URI") textTarget = { tag, field: "uri" };
        else if (tag === "z:PMID") textTarget = { tag, field: "pmid" };
        else if (tag === "prism:volume") textTarget = { tag, field: "volume" };
        else if (tag === "prism:number") textTarget = { tag, field: "issue" };
        else if (tag === "bib:pages") textTarget = { tag, field: "pages" };
        else if (tag === "dc:subject") textTarget = { tag, field: "subject" };
        else if (tag === "bib:Authors" || tag === "bib:authors") authorsDepth = tagStack.length;
        else if (tag === "bib:editors") editorsDepth = tagStack.length;
        else if (tag === "dcterms:isPartOf") partOfDepth = tagStack.length;
        else if (tag === "dc:publisher") {
          // A plain-text publisher (no nested foaf:Organization) still lands;
          // a nested foaf:name re-targets the same field before its text commits.
          textTarget = { tag, field: "publisherName" };
        }
      }
      // dcterms:isPartOf container: the nested bib:* (Journal/Book/…), then
      // its dc:title one level down (the container-title fill). Container
      // titles never sit at the entry's direct-child depth, so the depth
      // checks keep the article's own title authoritative.
      if (partOfDepth !== -1 && tag === "dc:title" && tagStack.length === partOfDepth + 2) {
        textTarget = { tag, field: "containerTitle" };
      }
      // Author/editor list: bib:Authors|bib:editors → rdf:Seq → rdf:li → foaf:Person.
      if ((authorsDepth !== -1 || editorsDepth !== -1) && (tag === "foaf:Person" || tag === "foaf:Organization")) {
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
      if (entry !== null) {
        if (editorsDepth !== -1) entry.editors.push(person);
        else entry.authors.push(person);
      }
      person = null;
      personIsOrg = false;
    }
    if (tag === "bib:Authors" || tag === "bib:authors") authorsDepth = -1;
    if (tag === "bib:editors") editorsDepth = -1;
    if (partOfDepth !== -1 && tagStack.length - 1 === partOfDepth) partOfDepth = -1;
    if (entry !== null && tag === entryTag && tagStack.length - 1 === entryDepth) {
      // Entry closes: only keyed entries become items (journals etc. count
      // as skipped AND are listed — idempotency needs the stable key).
      if (entry.citekey !== undefined && entry.citekey.trim().length > 0) {
        tagsSkipped += entry.tags;
        items.push(entryToCsl(entryTag!, entry));
      } else {
        skipped += 1;
        keylessSkipped.push({ id: entry.aboutId, title: entry.title ?? "" });
      }
      entry = null;
      entryTag = null;
      entryDepth = -1;
      authorsDepth = -1;
      editorsDepth = -1;
      partOfDepth = -1;
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
  return { items, skipped, keylessSkipped, tagsSkipped, attachmentsSkipped };
}

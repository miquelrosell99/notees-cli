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
 *   - `dc:publisher` nests `foaf:Organization`/`foaf:name` — ONLY the name is
 *     captured (a vcard:address locality never is); several organizations
 *     join with "; "; an organization without a name is counted
 *     (`publisherNameMissing`), never address-guessed.
 *
 * The vocabulary is the full Zotero alignment slice (mirroring the main
 * repo's bulk-importer parser, `scripts/zotero-rdf-parser.mts` in the
 * vendored monorepo): the direct-scalar table {@link ZOTERO_VOCAB} maps
 * Zotero's RDF terms to Notees pool property names, plus the structural
 * shapes — `dc:identifier` (prefixed ISBN/DOI/ISSN/PMID, plain/nested URLs),
 * `dc:subject`/`dcterms:LCC` (the call number), `dc:relation`, `z:shortTitle`
 * winning over `dcterms:alternative`, and `dcterms:isPartOf` container
 * resolution (the container resource's tag decides the title field; its
 * scalar fields and ISSN merge in, the item's own values always winning).
 * `dc:subject` plain-text tags stay counted-but-unmapped: class tags are a
 * different semantics. The CLI's fill step gates every parsed field through
 * the vendored per-class binding roster (SYSTEM_SOURCE_CLASS_BINDINGS) plus
 * the source base family, so a field bound nowhere on the item's class never
 * becomes a fill.
 *
 * sax matches prefixed tag names literally (no namespace resolution), decodes
 * entities, and may deliver character data in chunks — this module tracks the
 * element stack and accumulates leaf text.
 */

import sax from "sax";

import { ZOTERO_ITEM_TYPE_TO_CLASS, type SystemPropertyName } from "@notees/domain";
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
  /** Unclassified dc:identifier values → the Identifier schema. */
  identifiers?: string[];
  /** The full-alignment vocabulary (pool property names match the schemas). */
  rights?: string;
  edition?: string;
  pmid?: string;
  pmcid?: string;
  numPages?: string;
  libraryCatalog?: string;
  court?: string;
  code?: string;
  codeNumber?: string;
  workType?: string;
  session?: string;
  accessDate?: string;
  callNumber?: string;
  /** dcterms:isPartOf: the pool property the container title fills, decided by the container resource's tag. */
  containerTitleProperty?: SystemPropertyName;
  /** dcterms:isPartOf: the container's ISSN (item-wins already applied). */
  containerIssn?: string;
  /** dcterms:isPartOf: container scalar fields merged item-wins, pool-keyed. */
  poolFields?: Record<string, string>;
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
  /** foaf:Organizations under dc:publisher WITHOUT a foaf:name — counted, never address-guessed. */
  publisherNameMissing: number;
}

/** The leaf fields the entry-level character data can belong to. */
type LeafField =
  | "citekey"
  | "itemType"
  | "title"
  | "date"
  | "abstract"
  | "language"
  | "shortTitle"
  | "altTitle"
  | "extra"
  | "uri"
  | "pmid"
  | "pmcid"
  | "rights"
  | "edition"
  | "numPages"
  | "libraryCatalog"
  | "court"
  | "code"
  | "codeNumber"
  | "workType"
  | "session"
  | "accessDate"
  | "identifierUrl"
  | "lccValue"
  | "containerField"
  | "containerIdentifier"
  | "volume"
  | "issue"
  | "pages"
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
  pmid?: string;
  pmcid?: string;
  identifiers: string[];
  abstract?: string;
  language?: string;
  shortTitle?: string;
  /** dcterms:alternative — the shortTitle fallback when z:shortTitle is absent. */
  altTitle?: string;
  extra?: string;
  uri?: string;
  rights?: string;
  edition?: string;
  numPages?: string;
  libraryCatalog?: string;
  court?: string;
  code?: string;
  codeNumber?: string;
  workType?: string;
  session?: string;
  accessDate?: string;
  callNumber?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  /** The nested dcterms:URI/rdf:value captured inside an open dc:identifier. */
  pendingUrl?: string;
  /** The dcterms:LCC/rdf:value captured inside an open dc:subject. */
  pendingLcc?: string;
  tags: number;
  publishers: string[];
  authors: CslName[];
  editors: CslName[];
  containerTag?: string;
  containerTitle?: string;
  containerFields: Record<string, string>;
  containerIssn?: string;
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

/**
 * The full-alignment vocab: a Zotero-RDF direct-scalar term → the Notees pool
 * property name (the vendored schemas — SYSTEM_PROPERTY_UUIDS keys). Mirrors
 * the main repo's bulk-importer parser VOCAB; structural terms
 * (dc:identifier, dc:publisher, dc:subject, dc:relation, the creator Seqs,
 * dcterms:isPartOf, dcterms:alternative) are parsed by dedicated walkers.
 */
const ZOTERO_VOCAB: Record<string, SystemPropertyName> = {
  "dcterms:abstract": "abstract",
  "dc:description": "extra",
  "dc:rights": "rights",
  "prism:volume": "volume",
  "prism:number": "issue",
  "prism:edition": "edition",
  "bib:pages": "pages",
  "z:language": "language",
  "z:PMCID": "pmcid",
  "z:numPages": "numPages",
  "z:shortTitle": "shortTitle",
  "z:libraryCatalog": "libraryCatalog",
  "z:authority": "court",
  "z:code": "code",
  "z:codeNumber": "codeNumber",
  "z:type": "workType",
  "z:session": "session",
  "z:url": "url",
  "dcterms:dateSubmitted": "accessDate",
};

/**
 * dcterms:isPartOf container resolution: the nested resource's element name
 * decides which pool property its dc:title fills (the main repo's
 * PART_OF_TITLE_FIELD). Unrecognized containers keep the fill's class-based
 * fallback (bookTitle for a book_section, publicationTitle otherwise).
 */
const PART_OF_TITLE_PROPERTY: Record<string, SystemPropertyName> = {
  "bib:Journal": "publicationTitle",
  "bib:Periodical": "publicationTitle",
  "bib:Book": "bookTitle",
  "bib:ConferenceProceedings": "proceedingsTitle",
  "bib:Series": "series",
  "bib:Website": "websiteTitle",
  "bib:Blog": "blogTitle",
};

/** The draft slot holding the item's own value for a vocab pool key
 * (the item always wins over a container repeat). */
function itemPoolValue(draft: DraftEntry, key: SystemPropertyName): string | undefined {
  switch (key) {
    case "abstract": return draft.abstract;
    case "extra": return draft.extra;
    case "rights": return draft.rights;
    case "volume": return draft.volume;
    case "issue": return draft.issue;
    case "edition": return draft.edition;
    case "pages": return draft.pages;
    case "language": return draft.language;
    case "pmid": return draft.pmid;
    case "pmcid": return draft.pmcid;
    case "numPages": return draft.numPages;
    case "shortTitle": return draft.shortTitle ?? draft.altTitle;
    case "libraryCatalog": return draft.libraryCatalog;
    case "court": return draft.court;
    case "code": return draft.code;
    case "codeNumber": return draft.codeNumber;
    case "workType": return draft.workType;
    case "session": return draft.session;
    case "url": return draft.uri;
    case "accessDate": return draft.accessDate;
    default: return undefined;
  }
}

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
function identifierOf(kind: "ISBN" | "ISSN" | "DOI" | "PMID", value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = new RegExp(`${kind}\\s*[:#]?\\s*([^\\s;,]+)`, "i").exec(value);
  return match === null ? undefined : match[1];
}

/** dc:identifier classification by prefix: isbn:/issn:/doi:/pmid: (or the
 *  textual "ISBN …" / "DOI …" forms) land on their schemas; a plain http(s)
 *  URL lands on url; anything else lands on the Identifier schema verbatim. */
function commitIdentifier(entry: DraftEntry, value: string): void {
  const lower = value.toLowerCase();
  if (lower.startsWith("isbn")) {
    entry.isbn = identifierOf("ISBN", value) ?? value;
  } else if (lower.startsWith("doi")) {
    entry.doi = identifierOf("DOI", value) ?? value;
  } else if (lower.startsWith("issn")) {
    entry.issn = identifierOf("ISSN", value) ?? value;
  } else if (lower.startsWith("pmid")) {
    entry.pmid = identifierOf("PMID", value) ?? value;
  } else if (/^https?:\/\/\S+$/i.test(value)) {
    entry.uri = value;
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
  if (draft.abstract !== undefined) item.abstract = draft.abstract;
  if (draft.language !== undefined) item.language = draft.language;
  // z:shortTitle wins over dcterms:alternative (the main repo's ruling).
  const shortTitle = draft.shortTitle ?? draft.altTitle;
  if (shortTitle !== undefined) item.shortTitle = shortTitle;
  if (draft.extra !== undefined) item.extra = draft.extra;
  if (draft.identifiers.length > 0) item.identifiers = draft.identifiers;
  if (draft.pmid !== undefined) item.pmid = draft.pmid;
  if (draft.pmcid !== undefined) item.pmcid = draft.pmcid;
  if (draft.rights !== undefined) item.rights = draft.rights;
  if (draft.edition !== undefined) item.edition = draft.edition;
  if (draft.numPages !== undefined) item.numPages = draft.numPages;
  if (draft.libraryCatalog !== undefined) item.libraryCatalog = draft.libraryCatalog;
  if (draft.court !== undefined) item.court = draft.court;
  if (draft.code !== undefined) item.code = draft.code;
  if (draft.codeNumber !== undefined) item.codeNumber = draft.codeNumber;
  if (draft.workType !== undefined) item.workType = draft.workType;
  if (draft.session !== undefined) item.session = draft.session;
  if (draft.accessDate !== undefined) item.accessDate = draft.accessDate;
  if (draft.callNumber !== undefined) item.callNumber = draft.callNumber;
  // dcterms:isPartOf resolution: the container title rides the CSL
  // container-title slot (downstream exporters) plus the pool-property pick
  // decided by the container resource's tag; the container's scalar fields
  // and ISSN merge into poolFields only where the item carries no value.
  if (draft.containerTitle !== undefined) item["container-title"] = draft.containerTitle;
  if (draft.containerTag !== undefined && PART_OF_TITLE_PROPERTY[draft.containerTag] !== undefined) {
    item.containerTitleProperty = PART_OF_TITLE_PROPERTY[draft.containerTag]!;
  }
  const poolFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(draft.containerFields)) {
    if (itemPoolValue(draft, key as SystemPropertyName) === undefined) poolFields[key] = value;
  }
  if (draft.containerIssn !== undefined && draft.issn === undefined) {
    item.containerIssn = draft.containerIssn;
  }
  if (Object.keys(poolFields).length > 0) item.poolFields = poolFields;
  return item;
}

export function parseZoteroRdf(text: string): ZoteroRdfParseResult {
  const parser = sax.parser(true, { trim: false, normalize: false });
  const items: ZoteroItem[] = [];
  let skipped = 0;
  const keylessSkipped: Array<{ id: string; title: string }> = [];
  let tagsSkipped = 0;
  let attachmentsSkipped = 0;
  let publisherNameMissing = 0;

  const tagStack: string[] = [];
  // The entry element currently open (null between entries).
  let entry: DraftEntry | null = null;
  let entryTag: string | null = null;
  let entryDepth = -1;
  // Leaf accumulator: which field the arriving character data belongs to.
  // `poolKey` carries the vocab target for containerField commits.
  let textTarget: { tag: string; field: LeafField; poolKey?: SystemPropertyName } | null = null;
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
  // dc:publisher tracking: the open element indexes, so ONLY the
  // foaf:Organization's foaf:name is captured — a vcard:address locality is
  // never the publisher (the live bug). An org closing without a name is
  // counted (publisherNameMissing), never address-guessed.
  let publisherDepth = -1;
  let publisherOrgDepth = -1;
  let publisherOrgHasName = false;
  // dc:identifier tracking: the element may be a plain-text leaf ("ISBN …")
  // or nest <dcterms:URI><rdf:value>…</dcterms:URI>; a bare rdf:resource
  // attribute is a URL. The direct text only counts when no child element
  // opened (pretty-printed exports never mix).
  let identifierDepth = -1;
  let identifierHasChildren = false;
  let identifierText = "";
  let identifierResource = "";
  let identifierUriDepth = -1;
  // dc:subject tracking: a plain-text subject is a counted tag; the
  // <dcterms:LCC><rdf:value> shape is the Library of Congress call number.
  let subjectDepth = -1;
  let subjectHasElement = false;
  let subjectText = "";
  let lccDepth = -1;
  // dc:relation tracking: an rdf:resource attribute is a URL (plain-text
  // relations carry no pool field).
  let relationDepth = -1;

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
        case "abstract":
          entry.abstract = value;
          break;
        case "language":
          entry.language = value;
          break;
        case "shortTitle":
          entry.shortTitle = value;
          break;
        case "altTitle":
          entry.altTitle = value;
          break;
        case "extra":
          entry.extra = value;
          break;
        case "uri":
          entry.uri = value;
          break;
        case "pmid":
          entry.pmid = value;
          break;
        case "pmcid":
          entry.pmcid = value;
          break;
        case "rights":
          entry.rights = value;
          break;
        case "edition":
          entry.edition = value;
          break;
        case "numPages":
          entry.numPages = value;
          break;
        case "libraryCatalog":
          entry.libraryCatalog = value;
          break;
        case "court":
          entry.court = value;
          break;
        case "code":
          entry.code = value;
          break;
        case "codeNumber":
          entry.codeNumber = value;
          break;
        case "workType":
          entry.workType = value;
          break;
        case "session":
          entry.session = value;
          break;
        case "accessDate":
          entry.accessDate = value;
          break;
        case "identifierUrl":
          entry.pendingUrl = value;
          break;
        case "lccValue":
          entry.pendingLcc = value;
          break;
        case "containerField":
          if (textTarget.poolKey !== undefined) entry.containerFields[textTarget.poolKey] = value;
          break;
        case "containerIdentifier": {
          // Only ISSN crosses over from a container — a journal's own DOI
          // is not the item's (the main repo's ruling).
          const match = /^ISSN\s+(\S+)/i.exec(value);
          if (match !== null) entry.containerIssn = match[1]!;
          break;
        }
        case "volume":
          entry.volume = value;
          break;
        case "issue":
          entry.issue = value;
          break;
        case "pages":
          entry.pages = value;
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
        entry = { aboutId: String(node.attributes["rdf:about"] ?? ""), authors: [], editors: [], identifiers: [], publishers: [], tags: 0, containerFields: {} };
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
        else if (tag === "dc:identifier") {
          identifierDepth = tagStack.length;
          identifierHasChildren = false;
          identifierText = "";
          identifierResource = String(node.attributes["rdf:resource"] ?? "");
        } else if (tag === "dcterms:alternative") textTarget = { tag, field: "altTitle" };
        else if (tag === "dcterms:URI") textTarget = { tag, field: "uri" };
        else if (tag === "z:PMID") textTarget = { tag, field: "pmid" };
        else if (tag === "dc:subject") {
          subjectDepth = tagStack.length;
          subjectHasElement = false;
          subjectText = "";
        } else if (tag === "dc:relation") {
          relationDepth = tagStack.length;
          const resource = String(node.attributes["rdf:resource"] ?? "");
          if (/^https?:\/\//i.test(resource)) entry.uri = resource;
        } else if (tag === "bib:Authors" || tag === "bib:authors") authorsDepth = tagStack.length;
        else if (tag === "bib:editors") editorsDepth = tagStack.length;
        else if (tag === "dcterms:isPartOf") partOfDepth = tagStack.length;
        else if (tag === "dc:publisher") publisherDepth = tagStack.length;
        else {
          // The full-alignment vocab: a direct-scalar Zotero term → its pool
          // property (z:url rides the shared uri/url slot).
          const poolKey = ZOTERO_VOCAB[tag];
          if (poolKey !== undefined) {
            textTarget = { tag, field: poolKey === "url" ? "uri" : (poolKey as LeafField), poolKey };
          }
        }
      }
      // Inside an open dc:identifier: any child element disqualifies the
      // direct text; <dcterms:URI><rdf:value> is the nested URL shape.
      if (identifierDepth !== -1 && tagStack.length > identifierDepth) {
        identifierHasChildren = true;
        if (tagStack.length === identifierDepth + 1 && tag === "dcterms:URI") {
          identifierUriDepth = tagStack.length;
        }
        if (identifierUriDepth !== -1 && tagStack.length === identifierUriDepth + 1 && tag === "rdf:value") {
          textTarget = { tag, field: "identifierUrl" };
        }
      }
      // Inside an open dc:subject: the <dcterms:LCC><rdf:value> shape is the
      // call number; any other child means the subject is not a plain tag.
      if (subjectDepth !== -1 && tagStack.length > subjectDepth) {
        subjectHasElement = true;
        if (tagStack.length === subjectDepth + 1 && tag === "dcterms:LCC") {
          lccDepth = tagStack.length;
        }
        if (lccDepth !== -1 && tagStack.length === lccDepth + 1 && tag === "rdf:value") {
          textTarget = { tag, field: "lccValue" };
        }
      }
      // Publisher organization: capture ONLY the foaf:name at the org's
      // direct-child depth; vcard:address and its locality never are.
      if (publisherDepth !== -1 && tagStack.length === publisherDepth + 1 && tag === "foaf:Organization") {
        publisherOrgDepth = tagStack.length;
        publisherOrgHasName = false;
      }
      if (publisherOrgDepth !== -1 && tagStack.length === publisherOrgDepth + 1 && tag === "foaf:name") {
        textTarget = { tag, field: "publisherName" };
        publisherOrgHasName = true;
      }
      // dcterms:isPartOf container: the nested bib:* (Journal/Book/…) — its
      // tag decides the title field — then its scalar vocab fields and ISSN
      // (the item's own values win at entry close). Container titles never
      // sit at the entry's direct-child depth, so the depth checks keep the
      // article's own title authoritative.
      if (partOfDepth !== -1 && tagStack.length === partOfDepth + 1 && tag.startsWith("bib:")) {
        entry.containerTag = tag;
      }
      if (partOfDepth !== -1 && tagStack.length === partOfDepth + 2) {
        if (tag === "dc:title") {
          textTarget = { tag, field: "containerTitle" };
        } else if (tag === "dc:identifier") {
          textTarget = { tag, field: "containerIdentifier" };
        } else {
          const poolKey = ZOTERO_VOCAB[tag];
          if (poolKey !== undefined) textTarget = { tag, field: "containerField", poolKey };
        }
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
    const text = typeof raw === "string" ? raw : String(raw);
    if (textTarget !== null) {
      textBuffer += text;
    } else if (identifierDepth !== -1 && !identifierHasChildren) {
      identifierText += text;
    } else if (subjectDepth !== -1 && !subjectHasElement) {
      subjectText += text;
    }
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
    if (publisherOrgDepth !== -1 && tagStack.length - 1 === publisherOrgDepth) {
      if (!publisherOrgHasName) publisherNameMissing += 1;
      publisherOrgDepth = -1;
    }
    if (publisherDepth !== -1 && tagStack.length - 1 === publisherDepth) publisherDepth = -1;
    if (identifierUriDepth !== -1 && tagStack.length - 1 === identifierUriDepth) identifierUriDepth = -1;
    if (identifierDepth !== -1 && tagStack.length - 1 === identifierDepth) {
      // Resolve the identifier: the nested URI wins, then the direct text,
      // then a bare rdf:resource URL; an empty identifier is skipped.
      if (entry !== null) {
        const { pendingUrl } = entry;
        delete entry.pendingUrl;
        if (pendingUrl !== undefined) {
          entry.uri = pendingUrl;
        } else if (!identifierHasChildren && identifierText.trim().length > 0) {
          commitIdentifier(entry, identifierText.trim());
        } else if (/^https?:\/\//i.test(identifierResource)) {
          entry.uri = identifierResource;
        }
      }
      identifierDepth = -1;
      identifierHasChildren = false;
      identifierText = "";
      identifierResource = "";
    }
    if (lccDepth !== -1 && tagStack.length - 1 === lccDepth) lccDepth = -1;
    if (subjectDepth !== -1 && tagStack.length - 1 === subjectDepth) {
      if (entry !== null) {
        const { pendingLcc } = entry;
        delete entry.pendingLcc;
        if (pendingLcc !== undefined) {
          entry.callNumber = pendingLcc;
        } else if (!subjectHasElement && subjectText.trim().length > 0) {
          entry.tags += 1;
        }
      }
      subjectDepth = -1;
      subjectHasElement = false;
      subjectText = "";
    }
    if (relationDepth !== -1 && tagStack.length - 1 === relationDepth) relationDepth = -1;
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
      identifierDepth = -1;
      subjectDepth = -1;
      relationDepth = -1;
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
  return { items, skipped, keylessSkipped, tagsSkipped, attachmentsSkipped, publisherNameMissing };
}

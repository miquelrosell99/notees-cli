/**
 * CSL-JSON import — the parser behind `notees import csl-json`.
 *
 * Accepts a top-level array of items or an object with an `items` array (the
 * Zotero "export as CSL JSON" shape). Items are lightly sanitized into the
 * vendored CslItem; anything without a usable string `id` (the citekey slot)
 * is dropped. Malformed JSON is the caller's usage error (exit 2), zero
 * usable items the caller's domain error (exit 1) — same contract as bibtex.
 */

import { type CslItem, type CslName } from "@notees/export";

import { isRecord } from "./markdown-export.js";

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

function sanitizeName(raw: unknown): CslName | null {
  if (!isRecord(raw)) return null;
  const family = textOf(raw.family);
  const given = textOf(raw.given);
  const literal = textOf(raw.literal);
  if (family === undefined && given === undefined && literal === undefined) return null;
  return {
    ...(family !== undefined ? { family } : {}),
    ...(given !== undefined ? { given } : {}),
    ...(literal !== undefined ? { literal } : {}),
  };
}

function sanitizeItem(raw: unknown): CslItem | null {
  if (!isRecord(raw)) return null;
  const id = textOf(raw.id);
  if (id === undefined) return null;
  const title = textOf(raw.title);
  const type = textOf(raw.type) ?? "article";
  const author = Array.isArray(raw.author) ? raw.author.map(sanitizeName).filter((n) => n !== null) : [];
  const dateParts = isRecord(raw.issued) && Array.isArray(raw.issued["date-parts"]) ? raw.issued["date-parts"] : null;
  const containerTitle = textOf(raw["container-title"]);
  const doi = textOf(raw.DOI);
  const isbn = textOf(raw.ISBN);
  const url = textOf(raw.URL);
  const publisher = textOf(raw.publisher);
  const volume = textOf(raw.volume);
  const issue = textOf(raw.issue);
  const page = textOf(raw.page);
  return {
    id,
    type,
    ...(title !== undefined ? { title } : {}),
    ...(author.length > 0 ? { author } : {}),
    ...(dateParts !== null ? { issued: { "date-parts": dateParts } } : {}),
    ...(containerTitle !== undefined ? { "container-title": containerTitle } : {}),
    ...(doi !== undefined ? { DOI: doi } : {}),
    ...(isbn !== undefined ? { ISBN: isbn } : {}),
    ...(url !== undefined ? { URL: url } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(issue !== undefined ? { issue } : {}),
    ...(page !== undefined ? { page } : {}),
  };
}

/**
 * Parse CSL-JSON text into items. Throws the given usage error on malformed
 * JSON or a non-array/non-`items` top level; returns the sanitized items
 * (possibly empty — the caller maps empty to the domain error).
 */
export function parseCslJson(
  text: string,
  usageError: (message: string) => never,
): CslItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    usageError(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const rawItems = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : usageError('expected a top-level array or an object with an "items" array');
  return rawItems
    .map(sanitizeItem)
    .filter((item): item is CslItem => item !== null);
}

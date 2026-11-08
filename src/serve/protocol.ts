/**
 * The /document wire contract — the single source the Word add-in lane codes
 * against. The parser is STRICT: any shape deviation is bad_request, never a
 * thrown exception (the server maps unexpected throws to bad_request too, but
 * validation belongs here where the contract lives).
 */

export type ServeErrorCode = "unknown_cmd" | "not_found" | "render_failed" | "bad_request";

export interface ServeErrorBody {
  ok: false;
  error: { code: ServeErrorCode; message: string };
}

export interface SearchResultItem {
  objectId: string;
  title: string;
  citekey?: string;
  authors?: string[];
  year?: number;
  classKey?: string;
}

export type ServeRequest =
  | { cmd: "search"; query: string }
  | { cmd: "render-citation"; objectIds: string[]; styleId: string; locator?: string }
  | { cmd: "render-bibliography"; objectIds: string[]; styleId: string }
  | { cmd: "list-styles" };

export type ServeResponse =
  | { ok: true; results: SearchResultItem[] }
  | { ok: true; citation: string }
  | { ok: true; bibliography: string }
  | { ok: true; styles: Array<{ id: string; label: string }> }
  | ServeErrorBody;

export function serveError(code: ServeErrorCode, message: string): ServeErrorBody {
  return { ok: false, error: { code, message } };
}

export function parseServeRequest(body: unknown):
  | { ok: true; request: ServeRequest }
  | { ok: false; response: ServeErrorBody } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, response: serveError("bad_request", "body must be a JSON object") };
  }
  const record = body as Record<string, unknown>;
  const cmd = record.cmd;
  if (typeof cmd !== "string") {
    return { ok: false, response: serveError("bad_request", "cmd is required") };
  }
  switch (cmd) {
    case "search": {
      if (typeof record.query !== "string" || record.query.length === 0) {
        return { ok: false, response: serveError("bad_request", "search requires a non-empty string query") };
      }
      return { ok: true, request: { cmd: "search", query: record.query } };
    }
    case "render-citation":
    case "render-bibliography": {
      const { objectIds, styleId, locator } = record;
      if (
        !Array.isArray(objectIds) ||
        objectIds.length === 0 ||
        !objectIds.every((id): id is string => typeof id === "string")
      ) {
        return { ok: false, response: serveError("bad_request", `${cmd} requires a non-empty string array objectIds`) };
      }
      if (typeof styleId !== "string" || styleId.length === 0) {
        return { ok: false, response: serveError("bad_request", `${cmd} requires a string styleId`) };
      }
      if (locator !== undefined && typeof locator !== "string") {
        return { ok: false, response: serveError("bad_request", "locator must be a string") };
      }
      return {
        ok: true,
        request:
          cmd === "render-citation"
            ? { cmd: "render-citation", objectIds, styleId, ...(locator !== undefined ? { locator } : {}) }
            : { cmd: "render-bibliography", objectIds, styleId },
      };
    }
    case "list-styles":
      return { ok: true, request: { cmd: "list-styles" } };
    default:
      return { ok: false, response: serveError("unknown_cmd", `unknown cmd "${cmd}"`) };
  }
}

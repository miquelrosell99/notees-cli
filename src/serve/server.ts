import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { CliError, EXIT } from "../exit-codes.js";
import { parseServeRequest, serveError, type ServeRequest, type ServeResponse } from "./protocol.js";
import type { ServeConfig } from "./config.js";

const MAX_BODY_BYTES = 1_048_576; // 1 MB — request bodies are tiny command envelopes

export interface Bridge {
  /** The ACTUAL bound port (config.port may be 0 = OS-assigned). */
  readonly port: number;
  /** The ACTUAL bound address — the loopback proof (config.host is 127.0.0.1). */
  readonly address: string;
  readonly token: string;
  /** Stops accepting, lets in-flight requests finish, frees the port. */
  close(): Promise<void>;
}

export interface BridgeHandlers {
  /** Executes one parsed command against the local store. Must never throw. */
  dispatch(request: ServeRequest): Promise<ServeResponse>;
}

/** Signals the body cap; handled as 413, not the catch-all 400. */
class BodyTooLargeError extends Error {}

function statusFor(response: ServeResponse): number {
  if (response.ok) return 200;
  // Transport semantics in the HTTP status; the wire code stays in the
  // four-value vocabulary (bad_request / unknown_cmd / not_found /
  // render_failed).
  if (response.error.code === "not_found") return 404;
  if (response.error.code === "render_failed") return 422;
  return 400;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLargeError("request body too large (max 1 MB)");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start the localhost bridge. The loopback bind is non-negotiable: the
 * config carries `host: "127.0.0.1"` as a literal type and the post-listen
 * address check fails the start (rather than serving) if the platform ever
 * resolved anything else.
 */
export async function startBridge(config: ServeConfig, handlers: BridgeHandlers): Promise<Bridge> {
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, config, handlers);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== config.host) {
    server.close();
    throw new CliError(EXIT.domain, `refusing to serve: bound address is not ${config.host}`);
  }
  return {
    port: address.port,
    address: address.address,
    token: config.token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // fetch/undici keeps idle keep-alive sockets open; close() waits on
        // them forever without this. In-flight requests are untouched —
        // close() only resolves after they drain.
        server.closeIdleConnections();
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServeConfig,
  handlers: BridgeHandlers,
): Promise<void> {
  let answered = false;
  const respond = (status: number, body: ServeResponse): void => {
    if (answered) return;
    answered = true;
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      // Loopback pairing bridge: a fresh socket per request keeps close()
      // drain prompt instead of waiting out client keep-alive timeouts.
      connection: "close",
    });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "POST" || req.url !== "/document") {
      respond(404, serveError("bad_request", "POST /document only"));
      return;
    }
    const origin = req.headers.origin;
    // Exact-match allowlist: once one exists, every request needs an Origin
    // header carrying a listed value — a missing header is not a pass.
    if (config.origins.length > 0 && (typeof origin !== "string" || !config.origins.includes(origin))) {
      respond(403, serveError("bad_request", "origin is not allowed"));
      return;
    }
    if (req.headers.authorization !== `Bearer ${config.token}`) {
      respond(401, serveError("bad_request", "missing or invalid bearer token"));
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      respond(400, serveError("bad_request", "body is not valid JSON"));
      return;
    }
    const request = parseServeRequest(parsed);
    if (!request.ok) {
      respond(400, request.response);
      return;
    }
    const response = await handlers.dispatch(request.request);
    respond(statusFor(response), response);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      respond(413, serveError("bad_request", error.message));
      return;
    }
    // A dispatch (or plumbing) exception is a 500 with a generic body: the
    // server never crashes and never leaks internals through the wire.
    respond(500, serveError("bad_request", "internal error"));
  }
}

/**
 * FakeRelay — the mocked-wire replacement for the plan-07 local-first
 * architecture. The old unit specs mocked the server's content REST API
 * (GET /api/objects…, retired in plan 07); the CLI now syncs through the
 * relay wire protocol into a local derived store, so the mock sits one layer
 * down: it implements the few relay/coordination endpoints the sync engine
 * and the surviving reads touch, over an in-memory envelope log.
 *
 * - GET  /api/workspaces/:id/key            → 404 (a keyless workspace)
 * - GET  /api/relay/v2/snapshot             → hasSnapshot:false (catch-up path)
 * - GET  /api/relay/v2/snapshot/data        → 404
 * - POST /api/relay/v2/catch-up             → pages over the envelope log
 * - POST /api/relay/v2/batch                → appends to the log (captured)
 * - GET  /api/relay/v2/stats                → log-derived watermarks
 * - GET  /api/features                      → configurable rows
 * - GET  /api/property-schemas[…]           → configurable rows
 * - anything else                           → 500 (a route the spec didn't plan)
 *
 * Seeding graph state = appending envelopes to the log (a create, an
 * archive, …); every CLI run syncs first, so the next command sees it.
 */

import type { Envelope } from "@notees/protocol";

export interface RecordedCall {
  method: string;
  path: string;
  /** The parsed JSON body when the request carried one (POST/PUT/PATCH). */
  body?: unknown;
}

const JSON_HEADERS = { "content-type": "application/json" };

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

export class FakeRelay {
  readonly calls: RecordedCall[] = [];
  /** Captured JSON request bodies by request order (POST/PUT/PATCH only). */
  readonly bodies: unknown[] = [];
  /** The envelope log — the workspace's whole authority. */
  private log: Envelope[] = [];
  /** Configurable coordination reads. */
  features: Array<Record<string, unknown>> = [];
  propertySchemas: Array<Record<string, unknown>> = [];
  /** Extra responders: first match on "METHOD /path/regex" wins, before the defaults. */
  responders: Array<{ method: string; pattern: RegExp; status: number; body: (url: URL) => unknown }> = [];

  /** Reset the workspace + the recordings (the durable store file is the spec's job). */
  reset(): void {
    this.calls.length = 0;
    this.bodies.length = 0;
    this.log = [];
    this.features = [];
    this.propertySchemas = [];
    this.responders = [];
  }

  /** Seed graph state: append an envelope straight onto the log. */
  append(...envelopes: Envelope[]): void {
    this.log.push(...envelopes);
  }

  /** The relay-batch request bodies captured so far ({envelopes: [...]} each),
   * paired with their calls — the flat `bodies` list also carries catch-up
   * POSTs, so batch assertions must filter by path. */
  batchBodies(): Array<{
    envelopes: Array<{
      opType: string;
      payload: Record<string, unknown>;
      client?: string;
      deviceId?: string;
      affectedNodeIds?: string[];
    }>;
  }> {
    return this.calls
      .filter((call) => call.method === "POST" && call.path === "/api/relay/v2/batch")
      .map((call) => call.body as {
        envelopes: Array<{
          opType: string;
          payload: Record<string, unknown>;
          client?: string;
          deviceId?: string;
          affectedNodeIds?: string[];
        }>;
      });
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
  }

  /** The fetch implementation to hand to vi.stubGlobal("fetch", relay.fetch). */
  fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    let parsedBody: unknown;
    if (init?.body !== undefined && typeof init.body === "string") {
      parsedBody = JSON.parse(init.body);
      this.bodies.push(parsedBody);
    }
    this.calls.push({ method, path: url.pathname + url.search, body: parsedBody });

    const responder = this.responders.find((r) => r.method === method && r.pattern.test(url.pathname));
    if (responder !== undefined) {
      return this.json(responder.body(url), responder.status);
    }

    if (method === "GET" && /^\/api\/workspaces\/[^/]+\/key$/.test(url.pathname)) {
      return this.json(errorBody("not_found", "no workspace key stored"), 404);
    }
    if (method === "GET" && url.pathname === "/api/relay/v2/snapshot") {
      return this.json({
        snapshotId: "",
        hlc: { physical: 0, logical: 0 },
        hasSnapshot: false,
        restoreEpoch: 0,
        upToSeq: null,
        sealed: false,
      });
    }
    if (method === "GET" && url.pathname === "/api/relay/v2/snapshot/data") {
      return this.json(errorBody("not_found", "no snapshot stored"), 404);
    }
    if (method === "POST" && url.pathname === "/api/relay/v2/catch-up") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { afterSeq?: number; limit?: number };
      const afterSeq = body.afterSeq ?? 0;
      const limit = body.limit ?? 1000;
      const page = this.log.slice(afterSeq, afterSeq + limit);
      const nextAfterSeq = afterSeq + page.length;
      return this.json({
        envelopes: page,
        nextAfterSeq: nextAfterSeq < this.log.length ? nextAfterSeq : null,
        hasMore: nextAfterSeq < this.log.length,
        restoreEpoch: 0,
        totalRemaining: this.log.length - afterSeq,
      });
    }
    if (method === "POST" && url.pathname === "/api/relay/v2/batch") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { envelopes?: Envelope[] };
      const envelopes = Array.isArray(body.envelopes) ? body.envelopes : [];
      this.log.push(...envelopes);
      return this.json({ savedCount: envelopes.length, savedIds: envelopes.map((envelope) => envelope.id) });
    }
    if (method === "PUT" && url.pathname === "/api/relay/v2/snapshot/data") {
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.pathname === "/api/relay/v2/stats") {
      let maxHlc = { physical: 0, logical: 0 };
      for (const envelope of this.log) {
        if (
          envelope.hlc.physical > maxHlc.physical ||
          (envelope.hlc.physical === maxHlc.physical && envelope.hlc.logical > maxHlc.logical)
        ) {
          maxHlc = envelope.hlc;
        }
      }
      return this.json({ envelopeCount: this.log.length, restoreEpoch: 0, maxHlc });
    }
    if (method === "GET" && url.pathname === "/api/classes") {
      return this.json({ classes: [] });
    }
    if (method === "GET" && url.pathname === "/api/features") {
      return this.json({ features: this.features });
    }
    if (method === "GET" && url.pathname === "/api/property-schemas") {
      return this.json({ propertySchemas: this.propertySchemas });
    }
    return this.json(
      errorBody("unexpected", `mock relay: no responder for ${method} ${url.pathname}${url.search}`),
      500,
    );
  };
}

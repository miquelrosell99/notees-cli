/**
 * Minimal fetch client for the server API: X-API-Key auth, JSON handling,
 * wire-error mapping onto the exit-code contract, and network-failure
 * detection (any fetch-level failure is exit 5).
 */

import { CliError, EXIT, exitCodeForWireError, type WireErrorBody } from "./exit-codes.js";

export interface ClientOptions {
  server: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ApiClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ClientOptions) {
    this.base = options.server.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get apiKey(): string {
    return this.options.apiKey;
  }

  get server(): string {
    return this.base;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    headers.set("x-api-key", this.options.apiKey);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        signal: controller.signal,
        headers,
      });
    } catch (error) {
      // DNS, refused, abort, TLS — anything that never produced a wire answer.
      const reason = error instanceof Error ? error.name : String(error);
      throw new CliError(EXIT.network, `cannot reach server at ${this.base} (${reason})`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let code: string | undefined;
      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as WireErrorBody;
        if (body.error !== undefined) {
          code = body.error.code;
          message = body.error.message ?? message;
        }
      } catch {
        // Not a JSON envelope; keep the status-based message.
      }
      throw new CliError(exitCodeForWireError(response.status, code), message, { status: response.status, code });
    }
    return response;
  }

  async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path);
    return (await response.json()) as T;
  }

  async getBytes(path: string, init: RequestInit = {}): Promise<Response> {
    return this.request(path, init);
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  }

  async patchJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  }

  async deleteJson<T>(path: string): Promise<T> {
    const response = await this.request(path, { method: "DELETE" });
    return (await response.json()) as T;
  }

  async postMultipart<T>(path: string, form: FormData): Promise<T> {
    const response = await this.request(path, { method: "POST", body: form });
    return (await response.json()) as T;
  }
}

/**
 * Minimal fetch client for the server API: X-API-Key auth, workspace
 * selection, JSON handling, wire-error mapping onto the exit-code contract,
 * and network-failure detection (any fetch-level failure is exit 5).
 */

import { CliError, EXIT, exitCodeForWireError, type WireErrorBody } from "./exit-codes.js";
import { defaultStatePath, serverState, updateServerState } from "./state.js";

export interface ClientOptions {
  server: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Workspace name or uuid (the --workspace flag / NOTEES_WORKSPACE env).
   * A uuid is used verbatim; a name is resolved against /api/workspaces
   * (case-insensitive) and cached per profile in the CLI state file. Every
   * request then carries x-workspace-id, addressing the object API at this
   * workspace instead of the server's default. Without it, the CLI keeps the
   * server-side default-workspace behavior.
   */
  workspace?: string;
  /** State-file location and server key for the name→id cache. */
  statePath?: string;
  stateKey?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApiClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private workspacePromise: Promise<string | undefined> | null = null;

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

  /**
   * The workspace id this client addresses (x-workspace-id on every
   * request). Lazy and memoized: name resolution costs one /api/workspaces
   * call, then rides the per-profile state cache.
   */
  async workspaceId(): Promise<string | undefined> {
    if (this.workspacePromise === null) {
      this.workspacePromise = this.resolveWorkspace();
    }
    return this.workspacePromise;
  }

  private async resolveWorkspace(): Promise<string | undefined> {
    const workspace = this.options.workspace?.trim();
    if (workspace === undefined || workspace === "") return undefined;
    if (UUID_PATTERN.test(workspace)) return workspace;
    // A name: resolve through the account's workspace listing (raw fetch —
    // the listing is account-scoped, reads no x-workspace-id, and calling
    // getJson here would await the very promise now being resolved).
    const statePath = this.options.statePath ?? defaultStatePath();
    const stateKey = this.options.stateKey ?? this.options.server;
    const cacheKey = workspace.toLowerCase();
    const cached = serverState(statePath, stateKey).workspaces?.[cacheKey];
    if (cached !== undefined) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/api/workspaces`, {
        headers: { "x-api-key": this.options.apiKey },
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : String(error);
      throw new CliError(EXIT.network, `cannot reach server at ${this.base} (${reason})`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // The workspace listing is account-scoped: 401 here means the
      // credential is not an account credential (e.g. the operator key) —
      // name resolution needs a session token or user API key; a workspace
      // id passes through verbatim and works with any credential.
      if (response.status === 401) {
        throw new CliError(
          EXIT.usage,
          `resolving workspace "${workspace}" by name needs an account credential (session token or user API key) — pass the workspace id instead`,
        );
      }
      throw new CliError(EXIT.auth, `workspace resolution failed (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { workspaces?: { id: string; name: string }[] };
    const available = Array.isArray(body.workspaces) ? body.workspaces : [];
    const hit = available.find((entry) => entry.name.toLowerCase() === cacheKey);
    if (hit === undefined) {
      const names = available.map((entry) => entry.name).join(", ") || "(none)";
      throw new CliError(EXIT.usage, `workspace "${workspace}" not found — available: ${names}`);
    }
    updateServerState(statePath, stateKey, (current) => ({
      ...current,
      workspaces: { ...current.workspaces, [cacheKey]: hit.id },
    }));
    return hit.id;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    headers.set("x-api-key", this.options.apiKey);
    const workspaceId = await this.workspaceId();
    if (workspaceId !== undefined) {
      headers.set("x-workspace-id", workspaceId);
    }
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

  async putJson<T>(path: string, body: unknown = {}): Promise<T> {
    const response = await this.request(path, {
      method: "PUT",
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

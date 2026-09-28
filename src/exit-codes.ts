/**
 * CLI exit-code contract: 0 ok, 1 domain error, 2 usage, 3 auth,
 * 4 conflict, 5 network. Wire errors (the §3 envelope) map onto these codes.
 */

export const EXIT = {
  ok: 0,
  domain: 1,
  usage: 2,
  auth: 3,
  conflict: 4,
  network: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure the CLI reports; carries the process exit code. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface WireErrorBody {
  error?: { code?: string; message?: string; status?: number };
}

/** Map a wire error envelope to the deterministic exit code. */
export function exitCodeForWireError(status: number, code: string | undefined): ExitCode {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 409 || code === "conflict" || code === "idempotency_replay") return EXIT.conflict;
  if (status === 404 || status === 400 || status === 422 || status === 416) return EXIT.domain;
  if (status === 429) return EXIT.domain;
  return EXIT.domain;
}

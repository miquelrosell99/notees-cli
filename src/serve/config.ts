import { randomBytes } from "node:crypto";

import { CliError, EXIT } from "../exit-codes.js";

export interface ServeConfig {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly origins: readonly string[];
  readonly token: string;
  readonly tokenFile?: string;
  readonly syncIntervalMs: number;
  readonly stylesDir?: string;
}

/**
 * Flag/env resolution for `notees serve`. The loopback bind has no flag —
 * it is the command's reason to exist (the Word add-in ↔ localhost bridge),
 * so `host` is a constant, not an option.
 */
export function resolveServeConfig(options: {
  port?: string;
  origin?: string[];
  tokenFile?: string;
  syncInterval?: string;
  stylesDir?: string;
}, env: NodeJS.ProcessEnv = process.env): ServeConfig {
  const portText = options.port ?? "8474";
  const port = strictInteger(portText);
  if (port === undefined || port < 0 || port > 65535) {
    throw new CliError(EXIT.usage, `--port must be an integer between 0 and 65535 (got "${portText}")`);
  }
  const syncIntervalText = options.syncInterval ?? "60";
  const syncSeconds = strictInteger(syncIntervalText);
  if (syncSeconds === undefined || syncSeconds < 5) {
    throw new CliError(EXIT.usage, "--sync-interval must be an integer >= 5 seconds");
  }
  const envToken = env.NOTEES_SERVE_TOKEN;
  return {
    host: "127.0.0.1",
    port,
    origins: options.origin ?? [],
    token: envToken !== undefined && envToken.length > 0 ? envToken : randomBytes(24).toString("base64url"),
    ...(options.tokenFile !== undefined ? { tokenFile: options.tokenFile } : {}),
    syncIntervalMs: syncSeconds * 1000,
    ...(options.stylesDir !== undefined ? { stylesDir: options.stylesDir } : {}),
  };
}

/**
 * Whole-string integer parse: Number.parseInt alone would accept "1.5" as 1,
 * silently rounding flag values the caller meant to be rejected.
 */
function strictInteger(text: string): number | undefined {
  if (!/^-?\d+$/.test(text.trim())) return undefined;
  return Number.parseInt(text, 10);
}

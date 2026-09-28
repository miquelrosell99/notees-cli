/**
 * Deterministic uuid derivation mirroring the server's identity.ts — the
 * default workspace id is a fixed function of the string
 * "notees:workspace:default", so the CLI can address the server's default
 * workspace without configuration.
 */

import { createHash } from "node:crypto";

export function deriveUuid(namespace: string): string {
  const digest = createHash("sha256").update(namespace).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const DEFAULT_WORKSPACE_ID = deriveUuid("notees:workspace:default");

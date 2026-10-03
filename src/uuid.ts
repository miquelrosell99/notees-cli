/**
 * Deterministic uuid derivation mirroring the server's identity.ts — the
 * default workspace id is a fixed function of the string
 * "notees:workspace:default", so the CLI can address the server's default
 * workspace without configuration.
 */

import { createHash, randomBytes } from "node:crypto";

export function deriveUuid(namespace: string): string {
  const digest = createHash("sha256").update(namespace).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const DEFAULT_WORKSPACE_ID = deriveUuid("notees:workspace:default");

/**
 * RFC 9562 UUIDv7 from node:crypto — the CLI carries no uuidv7 dependency,
 * and identity is UUIDv7 everywhere by design law (property schemas created
 * here get a fresh v7 id, same as every other client).
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  // 48-bit big-endian unix-ms timestamp in the first six bytes.
  const hi = Math.floor(now / 0x100000000);
  const lo = now % 0x100000000;
  bytes[0] = (hi >>> 8) & 0xff;
  bytes[1] = hi & 0xff;
  bytes[2] = (lo >>> 24) & 0xff;
  bytes[3] = (lo >>> 16) & 0xff;
  bytes[4] = (lo >>> 8) & 0xff;
  bytes[5] = lo & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

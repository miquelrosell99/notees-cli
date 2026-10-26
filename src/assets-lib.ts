/**
 * Shared asset-upload mechanics for the CLI surface (the `notees asset`
 * commands and the shell's scripting helpers): input expansion (files +
 * recursive directory walks) and the multipart upload itself. One home so
 * the command and the REPL helper can never drift on batch semantics.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { ApiClient } from "./client.js";
import { CliError, EXIT } from "./exit-codes.js";

/**
 * Expand bulk-upload inputs: files given directly plus every regular file
 * under any directory (recursive walk, name-sorted per level for
 * deterministic output). Nonexistent/unreadable paths and unreadable
 * directories are per-item failures, not usage errors — one bad path must
 * not abort a bulk import. Non-regular entries (sockets, fifos, …) are
 * skipped silently.
 */
export function expandAssetInputs(inputs: string[]): {
  files: string[];
  failures: Array<{ file: string; error: string }>;
} {
  const files: string[] = [];
  const failures: Array<{ file: string; error: string }> = [];
  const visit = (input: string): void => {
    let stat;
    try {
      stat = statSync(input);
    } catch (error) {
      failures.push({ file: input, error: `cannot read: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(input, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch (error) {
        failures.push({ file: input, error: `cannot list: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      for (const entry of entries) visit(join(input, entry.name));
    } else if (stat.isFile()) {
      files.push(input);
    }
  };
  for (const input of inputs) visit(input);
  return { files, failures };
}

/**
 * Fail loud (exit domain via the client's 404 mapping) when a node id does
 * not exist — asset.attach's applier upserts node_asset rows without
 * validating the node, so without this check an attach to a dangling id
 * would silently succeed and leave an orphan row.
 */
export async function assertObjectExists(client: ApiClient, objectId: string): Promise<void> {
  await client.getJson<unknown>(`/api/objects/${encodeURIComponent(objectId)}`);
}

/**
 * Upload one file's bytes (optionally attaching to a node) — returns the CAS
 * asset id. An unreadable file is a usage error, matching the CLI contract.
 */
export async function uploadAssetFile(client: ApiClient, filePath: string, objectId?: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new CliError(EXIT.usage, `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const form = new FormData();
  form.append("file", new Blob([bytes]), basename(filePath));
  if (objectId !== undefined) form.append("objectId", objectId);
  const body = await client.postMultipart<{ assetId: string }>("/api/assets", form);
  return body.assetId;
}

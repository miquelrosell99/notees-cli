/**
 * Small stdin/query helpers shared by the command handlers and the shell.
 */

export interface StdinSource {
  stdin?: NodeJS.ReadableStream | undefined;
}

export function readStdin(source: StdinSource): Promise<string> {
  const stdin = source.stdin ?? process.stdin;
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk) => {
      data += String(chunk);
    });
    stdin.on("end", () => resolve(data));
    stdin.on("error", reject);
  });
}

export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== "");
  if (entries.length === 0) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
}

/**
 * Compact fixed-width table for human output (JSON mode never rides this).
 * The first row is the header. Long cells truncate with an ellipsis; wide
 * columns get at most `maxWidth` chars so a single long title can't blow the
 * layout. No colors — the output stays pipe/grep friendly.
 */
export function formatTable(rows: string[][], maxWidth = 64): string {
  if (rows.length === 0) return "";
  const width = rows[0]!.length;
  const clipped = rows.map((row) =>
    row.map((cell) => {
      const text = cell.includes("\n") ? cell.replace(/\s+/g, " ").trim() : cell;
      return text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text;
    }),
  );
  const widths = Array.from({ length: width }, (_, column) =>
    Math.max(...clipped.map((row) => (row[column] ?? "").length)),
  );
  return clipped
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd())
    .join("\n");
}

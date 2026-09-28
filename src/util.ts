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

export function queryString(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== "");
  if (entries.length === 0) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
}

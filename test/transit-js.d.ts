/**
 * transit-js ships no type declarations — the test suite uses the JSON
 * dialect's writer surface only (encoding the Logseq kvs fixture rows), typed
 * loosely here. (The vendored @notees/export carries the same shim for its
 * decoder; this copy keeps the CLI's tests independent of vendor internals.)
 */
declare module "transit-js" {
  const transit: {
    reader(type: string): { read(value: string): unknown };
    writer(type: string): { write(value: unknown): string };
    keyword(name: string): unknown;
    uuid(value: string): unknown;
    isKeyword(value: unknown): boolean;
    isSymbol(value: unknown): boolean;
    isUUID(value: unknown): boolean;
    isMap(value: unknown): boolean;
    isList(value: unknown): boolean;
    isSet?(value: unknown): boolean;
    map(entries: unknown[]): unknown;
    list?(entries: unknown[]): unknown;
    set?(entries: unknown[]): unknown;
  };
  export default transit;
}

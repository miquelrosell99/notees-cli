import { serveError, type ServeRequest, type ServeResponse } from "./protocol.js";

/**
 * The /document command dispatcher. Tasks 4/7/8 fill in the real arms; the
 * shell already fixes the shape: dispatch NEVER throws — every failure is an
 * error envelope (the server turns unexpected throws into bad_request).
 */
export async function dispatchDocument(
  context: unknown,
  request: ServeRequest,
): Promise<ServeResponse> {
  void context;
  return serveError("unknown_cmd", `cmd "${request.cmd}" is not wired yet`);
}

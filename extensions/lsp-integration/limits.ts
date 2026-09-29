/**
 * How long one lsp tool call may take, whichever backend answers it.
 *
 * The standalone backend holds each request to two minutes of its own,
 * but a backend a paired editor registered may hold none, so the tool
 * keeps a clock too. It sits a little past the standalone one, so the
 * backend's own clock, and the cancellation it sends the server, is the
 * one that fires when both could.
 */
export const LSP_CALL_WALL_MS = 150_000;

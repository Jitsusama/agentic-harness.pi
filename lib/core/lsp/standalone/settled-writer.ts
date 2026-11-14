/**
 * A message writer whose writes never reject.
 *
 * vscode-jsonrpc 9 rejects a request whose write fails, and then throws
 * the same error again inside its own async promise executor, where
 * nothing can catch it. Node makes that loose rejection an uncaught
 * exception. On 13 November one, from a language server that had died
 * under a busy client, took down the background pi host: it ran with no
 * conversation in its context, so the host parked every conversation
 * and exited 1. In a plain pi it ends the session.
 */

import type { MessageWriter } from "vscode-jsonrpc/node";

/**
 * Wrap `inner` so a failed write calls `failed` rather than rejecting.
 * `failed` is meant to dispose the connection, which rejects every
 * request still waiting, the one whose write failed among them, so each
 * caller still hears that its call failed.
 */
export function settledWriter(
	inner: MessageWriter,
	failed: () => void,
): MessageWriter {
	return {
		onError: inner.onError,
		onClose: inner.onClose,
		write: (message) => inner.write(message).catch(() => failed()),
		end: () => inner.end(),
		dispose: () => inner.dispose(),
	};
}

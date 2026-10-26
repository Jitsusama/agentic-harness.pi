/**
 * Waiting on localhost for the one browser redirect an OAuth login ends in.
 *
 * Google's and Slack's callback servers are this with different pages. The
 * part worth sharing is the part that was wrong in both: the wait took no
 * signal, so a person who gave up left a server holding the port until its
 * five-minute clock ran out, and that clock was never cleared on success,
 * so it held the process open for five minutes after every login.
 */

import * as http from "node:http";

/** How long a redirect is waited for before the wait gives up. */
export const REDIRECT_TIMEOUT_MS = 5 * 60 * 1000;

/** How the wait is bounded and what the browser is shown. */
export interface RedirectWait {
	/** Ends the wait, freeing the port, when it fires. */
	signal?: AbortSignal;
	/** Ends the wait after this long. Five minutes when absent. */
	timeoutMs?: number;
	/** The page for a redirect that carried a code. */
	success: string;
	/** The page for one that did not, given the error it carried. */
	failure: (error: string) => string;
}

/**
 * Listens on `port` until one request arrives, answers it with a page, and
 * resolves with its query. Rejects with an `AbortError` when the signal
 * fires and with a timeout error when the clock runs out; either way the
 * port is free again and no clock is left behind.
 */
export function waitForRedirect(
	port: number,
	wait: RedirectWait,
): Promise<URLSearchParams> {
	const { signal } = wait;
	if (signal?.aborted) return Promise.reject(aborted(signal));
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (settle: () => void): void => {
			if (done) return;
			done = true;
			clearTimeout(clock);
			signal?.removeEventListener("abort", onAbort);
			server.close();
			// A browser holds its connection open; closing only the listener
			// would leave the process waiting on it.
			server.closeAllConnections();
			settle();
		};
		const server = http.createServer((req, res) => {
			const query = new URL(req.url || "", `http://localhost:${port}`)
				.searchParams;
			const code = query.get("code");
			res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
			res.end(
				code ? wait.success : wait.failure(query.get("error") ?? ""),
				() => finish(() => resolve(query)),
			);
		});
		const onAbort = (): void => finish(() => reject(aborted(signal)));
		signal?.addEventListener("abort", onAbort, { once: true });
		const limit = wait.timeoutMs ?? REDIRECT_TIMEOUT_MS;
		const clock = setTimeout(
			() =>
				finish(() =>
					reject(
						new Error(
							`OAuth callback timeout after ${Math.round(limit / 60_000)} minutes`,
						),
					),
				),
			limit,
		);
		server.on("error", (error) => finish(() => reject(error)));
		server.listen(port, "localhost");
	});
}

/** Text made safe to put inside an HTML page. */
export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function aborted(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason;
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	return new DOMException("The OAuth login was cancelled.", "AbortError");
}

/**
 * Waiting on localhost for the one browser redirect an OAuth login ends in.
 *
 * Google's and Slack's callback servers are this with different pages. The
 * part worth sharing is the part that was wrong in both: the wait took no
 * signal, so a person who gave up left a server holding the port until its
 * five-minute clock ran out, and that clock was never cleared on success,
 * so it held the process open for five minutes after every login.
 *
 * The pages themselves are HTML and CSS in `oauth-pages/`, the same for
 * every service but for its name.
 */

import { readFileSync } from "node:fs";
import * as http from "node:http";

/** Where the pages a login's browser tab is shown live. */
const PAGES = new URL("./oauth-pages/", import.meta.url);

/**
 * A `%name%` a page leaves for its text, or the link to its stylesheet,
 * which the page is sent with written in. Both are filled in one pass, so
 * no text filled in is read again.
 */
const BLANK = /%(\w+)%|<link rel="stylesheet" href="page\.css">/g;

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

/**
 * The pages shown for a login to `service`, by name: one for a redirect
 * that carried a code, and one for a redirect that carried an error.
 */
export function redirectPages(
	service: string,
): Pick<RedirectWait, "success" | "failure"> {
	return {
		success: page("success.html", { service }),
		failure: (error) =>
			page("failure.html", { service, error: error || "Unknown error" }),
	};
}

/**
 * One page, with its stylesheet written in and each blank filled with its
 * text, escaped. A blank left without text is refused, as a misspelt
 * name would be, so no page reaches a browser saying `%error%`.
 */
function page(name: string, text: Readonly<Record<string, string>>): string {
	const styles = `<style>\n${readFileSync(new URL("page.css", PAGES), "utf8")}</style>`;
	const template = readFileSync(new URL(name, PAGES), "utf8");
	return template.replaceAll(BLANK, (_blank, key: string | undefined) => {
		if (key === undefined) return styles;
		const value = text[key];
		if (value === undefined) {
			throw new Error(`${name} leaves %${key}%, and nothing fills it`);
		}
		return escapeHtml(value);
	});
}

/** Text made safe to put inside an HTML page. */
function escapeHtml(text: string): string {
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

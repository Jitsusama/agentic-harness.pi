/**
 * Local HTTP server for the Slack OAuth2 callback.
 */

import {
	redirectPages,
	waitForRedirect,
} from "../../core/internal/oauth-redirect.ts";

/** Result from the local OAuth2 callback: either an auth code or an error. */
export interface OAuthCallbackResult {
	code?: string;
	state?: string;
	error?: string;
}

/** What the browser tab shows when the redirect lands. */
const PAGES = redirectPages("Slack");

/**
 * Start a local server to handle the Slack OAuth callback.
 * Resolves when the callback arrives; rejects when it times out, or with
 * an `AbortError` when `signal` fires, and frees the port either way.
 */
export async function waitForOAuthCallback(
	port: number,
	options: { signal?: AbortSignal } = {},
): Promise<OAuthCallbackResult> {
	const query = await waitForRedirect(port, {
		signal: options.signal,
		...PAGES,
	});
	return {
		code: query.get("code") || undefined,
		state: query.get("state") || undefined,
		error: query.get("error") || undefined,
	};
}

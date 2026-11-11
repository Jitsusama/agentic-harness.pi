/**
 * Local HTTP server for OAuth2 callback handling.
 */

import {
	redirectPages,
	waitForRedirect,
} from "../../core/internal/oauth-redirect.ts";

/** Result from the local OAuth2 callback server: either an auth code or an error. */
export interface OAuthCallbackResult {
	code?: string;
	error?: string;
}

/** What the browser tab shows when the redirect lands. */
const PAGES = redirectPages("Google");

/**
 * Start a local server to handle the OAuth callback.
 * Resolves when the callback arrives; rejects when it times out, or with
 * an `AbortError` when `signal` fires, and frees the port either way.
 */
export async function waitForOAuthCallback(
	port = 8765,
	options: { signal?: AbortSignal } = {},
): Promise<OAuthCallbackResult> {
	const query = await waitForRedirect(port, {
		signal: options.signal,
		...PAGES,
	});
	return {
		code: query.get("code") || undefined,
		error: query.get("error") || undefined,
	};
}

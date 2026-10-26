/**
 * Token management: storing and retrieving Slack OAuth tokens.
 */

import type { StoredToken } from "../types.ts";
import { readFile, writeFile } from "./store.ts";

// Re-export OAuth app types and functions for consumers.
export type { OAuthApp } from "../types.ts";
export { getOAuthApp, hasOAuthApp, storeOAuthApp } from "./oauth-app.ts";

/** Store a Slack token after successful authentication. */
export function storeToken(token: StoredToken): void {
	const data = readFile();
	data.token = token;
	writeFile(data);
}

/** Retrieve the stored Slack token. */
export function getToken(): StoredToken | null {
	return readFile().token ?? null;
}

/** Check whether a valid token exists. */
export function hasToken(): boolean {
	const token = getToken();
	return !!(token?.accessToken && token?.userId);
}

/** Clear all Slack configuration (OAuth app + token). */
export function clearAllConfig(): void {
	writeFile({ oauthApp: null, token: null });
}

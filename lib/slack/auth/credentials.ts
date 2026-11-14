/**
 * Token management: storing and retrieving Slack OAuth tokens,
 * kept in the desktop's keyring by store.ts.
 */

import type { StoredToken } from "../types.ts";
import { readCredentials, writeCredentials } from "./store.ts";

// Re-export OAuth app types and functions for consumers.
export {
	getOAuthApp,
	hasOAuthApp,
	storeOAuthApp,
} from "./oauth-app.ts";

/** Store a Slack token after successful authentication. */
export async function storeToken(token: StoredToken): Promise<void> {
	const data = await readCredentials();
	data.token = token;
	await writeCredentials(data);
}

/** Retrieve the stored Slack token. */
export async function getToken(): Promise<StoredToken | null> {
	return (await readCredentials()).token ?? null;
}

/** Check whether a valid token exists. */
export async function hasToken(): Promise<boolean> {
	const token = await getToken();
	return !!(token?.accessToken && token?.userId);
}

/** Clear all Slack configuration (OAuth app + token). */
export async function clearAllConfig(): Promise<void> {
	await writeCredentials({ oauthApp: null, token: null });
}

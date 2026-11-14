/**
 * OAuth app credential management: storing and retrieving
 * the client ID and secret used for Google API authentication.
 */

import { readCredentials, writeCredentials } from "./store.ts";

/** OAuth app credentials (client ID + secret). */
export interface OAuthAppCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
}

/** Store OAuth app credentials. */
export async function storeOAuthApp(
	credentials: OAuthAppCredentials,
): Promise<void> {
	const data = await readCredentials();
	data.oauthApp = credentials;
	await writeCredentials(data);
}

/** Retrieve OAuth app credentials. */
export async function getOAuthApp(): Promise<OAuthAppCredentials | null> {
	return (await readCredentials()).oauthApp ?? null;
}

/** Check if OAuth app credentials are configured. */
export async function hasOAuthApp(): Promise<boolean> {
	const creds = await getOAuthApp();
	return !!(creds?.clientId && creds?.clientSecret);
}

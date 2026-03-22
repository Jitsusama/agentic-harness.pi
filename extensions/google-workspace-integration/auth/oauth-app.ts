/**
 * OAuth app credential management: storing and retrieving
 * the client ID and secret used for Google API authentication.
 */

import { readFile, writeFile } from "./store.js";

/** OAuth app credentials (client ID + secret). */
export interface OAuthAppCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
}

/** Store OAuth app credentials. */
export function storeOAuthApp(credentials: OAuthAppCredentials): void {
	const data = readFile();
	data.oauthApp = credentials;
	writeFile(data);
}

/** Retrieve OAuth app credentials. */
export function getOAuthApp(): OAuthAppCredentials | null {
	return readFile().oauthApp ?? null;
}

/** Check if OAuth app credentials are configured. */
export function hasOAuthApp(): boolean {
	const creds = getOAuthApp();
	return !!(creds?.clientId && creds?.clientSecret);
}

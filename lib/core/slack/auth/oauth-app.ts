/**
 * OAuth app credential management: storing and retrieving
 * the Slack app's client ID and secret.
 */

import type { OAuthApp } from "../types.ts";
import { readFile, writeFile } from "./store.ts";

/** Store OAuth app credentials. */
export function storeOAuthApp(credentials: OAuthApp): void {
	const data = readFile();
	data.oauthApp = credentials;
	writeFile(data);
}

/** Retrieve OAuth app credentials. */
export function getOAuthApp(): OAuthApp | null {
	return readFile().oauthApp ?? null;
}

/** Check if OAuth app credentials are configured. */
export function hasOAuthApp(): boolean {
	const creds = getOAuthApp();
	return !!(creds?.clientId && creds?.clientSecret);
}

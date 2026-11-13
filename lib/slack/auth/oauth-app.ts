/**
 * OAuth app credential management: storing and retrieving
 * the Slack app's client ID and secret.
 */

import type { OAuthApp } from "../types.ts";
import { readCredentials, writeCredentials } from "./store.ts";

/** Store OAuth app credentials. */
export async function storeOAuthApp(credentials: OAuthApp): Promise<void> {
	const data = await readCredentials();
	data.oauthApp = credentials;
	await writeCredentials(data);
}

/** Retrieve OAuth app credentials. */
export async function getOAuthApp(): Promise<OAuthApp | null> {
	return (await readCredentials()).oauthApp ?? null;
}

/** Check if OAuth app credentials are configured. */
export async function hasOAuthApp(): Promise<boolean> {
	const creds = await getOAuthApp();
	return !!(creds?.clientId && creds?.clientSecret);
}

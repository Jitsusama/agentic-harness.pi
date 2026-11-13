/**
 * Account and token management: storing, retrieving and
 * managing Google account configurations and their OAuth
 * tokens, kept in the desktop's keyring by store.ts.
 */

import type { Credentials } from "google-auth-library";
import type { GoogleAccount } from "../types.ts";
import { readCredentials, writeCredentials } from "./store.ts";

// Re-export OAuth app types and functions for consumers that
// previously imported everything from credentials.ts.
export type { OAuthAppCredentials } from "./oauth-app.ts";
export {
	getOAuthApp,
	hasOAuthApp,
	storeOAuthApp,
} from "./oauth-app.ts";

/** Store credentials for an account. */
export async function storeCredentials(
	account: string,
	credentials: Credentials,
): Promise<void> {
	const data = await readCredentials();
	data.tokens[account] = {
		access_token: credentials.access_token || "",
		refresh_token: credentials.refresh_token || "",
		expiry_date: credentials.expiry_date || 0,
		token_type: credentials.token_type || "Bearer",
		scope: credentials.scope || "",
	};
	await writeCredentials(data);
}

/** Retrieve credentials for an account. */
export async function getCredentials(
	account: string,
): Promise<Credentials | null> {
	const data = await readCredentials();
	const entry = data.tokens[account];
	if (!entry) return null;

	return {
		access_token: entry.access_token,
		refresh_token: entry.refresh_token,
		expiry_date: entry.expiry_date,
		token_type: entry.token_type,
		scope: entry.scope,
	};
}

/** List all configured accounts. */
export async function listAccounts(): Promise<GoogleAccount[]> {
	return (await readCredentials()).accounts;
}

/** Add or update an account. */
export async function saveAccount(account: GoogleAccount): Promise<void> {
	const data = await readCredentials();
	const existing = data.accounts.findIndex((a) => a.name === account.name);

	if (existing >= 0) {
		data.accounts[existing] = account;
	} else {
		data.accounts.push(account);
	}

	await writeCredentials(data);
}

/** Get the default account. */
export async function getDefaultAccount(): Promise<GoogleAccount | null> {
	const accounts = await listAccounts();
	return accounts.find((a) => a.isDefault) || accounts[0] || null;
}

/** Set the default account by name. */
export async function setDefaultAccount(accountName: string): Promise<void> {
	const data = await readCredentials();

	for (const account of data.accounts) {
		account.isDefault = account.name === accountName;
	}

	await writeCredentials(data);
}

/**
 * Clear all Google Workspace configuration (OAuth app,
 * accounts, tokens). Used for resetting to a fresh state.
 */
export async function clearAllConfig(): Promise<void> {
	await writeCredentials({ oauthApp: null, accounts: [], tokens: {} });
}

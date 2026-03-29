/**
 * Account and token management: storing, retrieving and
 * managing Google account configurations and their OAuth
 * tokens.
 */

import type { Credentials } from "google-auth-library";
import type { GoogleAccount } from "../types.js";
import { readFile, writeFile } from "./store.js";

// Re-export OAuth app types and functions for consumers that
// previously imported everything from credentials.ts.
export type { OAuthAppCredentials } from "./oauth-app.js";
export {
	getOAuthApp,
	hasOAuthApp,
	storeOAuthApp,
} from "./oauth-app.js";

/** Store credentials for an account. */
export function storeCredentials(
	account: string,
	credentials: Credentials,
): void {
	const data = readFile();
	data.tokens[account] = {
		access_token: credentials.access_token || "",
		refresh_token: credentials.refresh_token || "",
		expiry_date: credentials.expiry_date || 0,
		token_type: credentials.token_type || "Bearer",
		scope: credentials.scope || "",
	};
	writeFile(data);
}

/** Retrieve credentials for an account. */
export function getCredentials(account: string): Credentials | null {
	const data = readFile();
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
export function listAccounts(): GoogleAccount[] {
	return readFile().accounts;
}

/** Add or update an account. */
export function saveAccount(account: GoogleAccount): void {
	const data = readFile();
	const existing = data.accounts.findIndex((a) => a.name === account.name);

	if (existing >= 0) {
		data.accounts[existing] = account;
	} else {
		data.accounts.push(account);
	}

	writeFile(data);
}

/** Get the default account. */
export function getDefaultAccount(): GoogleAccount | null {
	const accounts = listAccounts();
	return accounts.find((a) => a.isDefault) || accounts[0] || null;
}

/** Set the default account by name. */
export function setDefaultAccount(accountName: string): void {
	const data = readFile();

	for (const account of data.accounts) {
		account.isDefault = account.name === accountName;
	}

	writeFile(data);
}

/**
 * Clear all Google Workspace configuration (OAuth app,
 * accounts, tokens). Used for resetting to a fresh state.
 */
export function clearAllConfig(): void {
	writeFile({ oauthApp: null, accounts: [], tokens: {} });
}

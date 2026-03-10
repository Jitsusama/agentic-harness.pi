/**
 * Credentials storage using Pi's session state.
 *
 * Credentials are stored in session state and lost on Pi restart.
 * Users will need to re-authenticate after restarting Pi.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { Credentials } from "google-auth-library";
import { getLastEntry } from "../../lib/state.js";
import type { GoogleAccount, StoredCredentials } from "../types.js";

const STATE_KEY_PREFIX = "google-workspace-creds";
const ACCOUNTS_KEY = "google-workspace-accounts";
const OAUTH_APP_KEY = "google-workspace-oauth-app";

/**
 * Store credentials for an account.
 */
export function storeCredentials(
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
	account: string,
	credentials: Credentials,
): void {
	const stored: StoredCredentials = {
		access_token: credentials.access_token || "",
		refresh_token: credentials.refresh_token || "",
		expiry_date: credentials.expiry_date || 0,
		token_type: credentials.token_type || "Bearer",
		scope: credentials.scope || "",
	};

	pi.appendEntry(`${STATE_KEY_PREFIX}:${account}`, stored);
}

/**
 * Retrieve credentials for an account.
 */
export function getCredentials(
	ctx: ExtensionContext,
	account: string,
): Credentials | null {
	const entry = getLastEntry<StoredCredentials>(
		ctx,
		`${STATE_KEY_PREFIX}:${account}`,
	);

	if (!entry) {
		return null;
	}

	return {
		access_token: entry.access_token,
		refresh_token: entry.refresh_token,
		expiry_date: entry.expiry_date,
		token_type: entry.token_type,
		scope: entry.scope,
	};
}

/**
 * List all configured accounts.
 */
export function listAccounts(ctx: ExtensionContext): GoogleAccount[] {
	const entry = getLastEntry<GoogleAccount[]>(ctx, ACCOUNTS_KEY);
	return entry || [];
}

/**
 * Add or update an account.
 */
export function saveAccount(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	account: GoogleAccount,
): void {
	const accounts = listAccounts(ctx);
	const existing = accounts.findIndex((a) => a.name === account.name);

	if (existing >= 0) {
		accounts[existing] = account;
	} else {
		accounts.push(account);
	}

	pi.appendEntry(ACCOUNTS_KEY, accounts);
}

/**
 * Get the default account.
 */
export function getDefaultAccount(ctx: ExtensionContext): GoogleAccount | null {
	const accounts = listAccounts(ctx);
	return accounts.find((a) => a.isDefault) || accounts[0] || null;
}

/**
 * Set the default account.
 */
export function setDefaultAccount(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	accountName: string,
): void {
	const accounts = listAccounts(ctx);

	for (const account of accounts) {
		account.isDefault = account.name === accountName;
	}

	pi.appendEntry(ACCOUNTS_KEY, accounts);
}

/**
 * OAuth app credentials.
 */
export interface OAuthAppCredentials {
	clientId: string;
	clientSecret: string;
}

/**
 * Store OAuth app credentials.
 */
export function storeOAuthApp(
	pi: ExtensionAPI,
	credentials: OAuthAppCredentials,
): void {
	pi.appendEntry(OAUTH_APP_KEY, credentials);
}

/**
 * Retrieve OAuth app credentials.
 */
export function getOAuthApp(ctx: ExtensionContext): OAuthAppCredentials | null {
	return getLastEntry<OAuthAppCredentials>(ctx, OAUTH_APP_KEY);
}

/**
 * Check if OAuth app credentials are configured.
 */
export function hasOAuthApp(ctx: ExtensionContext): boolean {
	const creds = getOAuthApp(ctx);
	return !!(creds?.clientId && creds?.clientSecret);
}

/**
 * Clear all Google Workspace configuration (OAuth app, accounts, tokens).
 * Used for testing or resetting to fresh state.
 */
export function clearAllConfig(pi: ExtensionAPI): void {
	// Clear OAuth app credentials
	pi.appendEntry(OAUTH_APP_KEY, null);

	// Clear accounts list
	pi.appendEntry(ACCOUNTS_KEY, []);

	// Note: Individual account credentials (google-workspace-creds:accountname)
	// will naturally become stale and be ignored. We could clear them explicitly
	// but they're harmless once accounts list is empty.
}

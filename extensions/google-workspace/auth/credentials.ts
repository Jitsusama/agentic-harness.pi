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

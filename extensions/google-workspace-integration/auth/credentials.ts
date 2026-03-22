/**
 * Credentials storage using file-based persistence.
 *
 * Credentials are stored in ~/.pi/agent/google-workspace.json and
 * survive across Pi sessions and restarts. The file contains OAuth
 * app credentials, account list and per-account tokens.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Credentials } from "google-auth-library";
import type { GoogleAccount, StoredCredentials } from "../types.js";

/** Path to the credentials file in Pi's global config directory. */
const CREDENTIALS_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"google-workspace.json",
);

/** Shape of the persisted credentials file. */
interface CredentialsFile {
	oauthApp?: OAuthAppCredentials | null;
	accounts: GoogleAccount[];
	tokens: Record<string, StoredCredentials>;
}

/** Read the credentials file, returning defaults if missing or corrupt. */
function readFile(): CredentialsFile {
	try {
		const raw = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
		return JSON.parse(raw) as CredentialsFile;
	} catch {
		// The file doesn't exist or is corrupt, so we start fresh.
		return { accounts: [], tokens: {} };
	}
}

/** Write the credentials file atomically. */
function writeFile(data: CredentialsFile): void {
	const dir = path.dirname(CREDENTIALS_PATH);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, "\t"), "utf-8");
}

/**
 * Store credentials for an account.
 */
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

/**
 * Retrieve credentials for an account.
 */
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

/**
 * List all configured accounts.
 */
export function listAccounts(): GoogleAccount[] {
	return readFile().accounts;
}

/**
 * Add or update an account.
 */
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

/**
 * Get the default account.
 */
export function getDefaultAccount(): GoogleAccount | null {
	const accounts = listAccounts();
	return accounts.find((a) => a.isDefault) || accounts[0] || null;
}

/**
 * Set the default account.
 */
export function setDefaultAccount(accountName: string): void {
	const data = readFile();

	for (const account of data.accounts) {
		account.isDefault = account.name === accountName;
	}

	writeFile(data);
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
export function storeOAuthApp(credentials: OAuthAppCredentials): void {
	const data = readFile();
	data.oauthApp = credentials;
	writeFile(data);
}

/**
 * Retrieve OAuth app credentials.
 */
export function getOAuthApp(): OAuthAppCredentials | null {
	return readFile().oauthApp ?? null;
}

/**
 * Check if OAuth app credentials are configured.
 */
export function hasOAuthApp(): boolean {
	const creds = getOAuthApp();
	return !!(creds?.clientId && creds?.clientSecret);
}

/**
 * Clear all Google Workspace configuration (OAuth app, accounts, tokens).
 * Used for testing or resetting to fresh state.
 */
export function clearAllConfig(): void {
	writeFile({ oauthApp: null, accounts: [], tokens: {} });
}

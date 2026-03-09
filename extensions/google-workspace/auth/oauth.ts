/**
 * OAuth2 authentication for Google Workspace APIs.
 */

import type { Credentials } from "google-auth-library";
import { OAuth2Client } from "google-auth-library";

/** OAuth2 scopes required for the extension. */
export const SCOPES = [
	// Gmail - read and modify (send, delete, archive)
	"https://www.googleapis.com/auth/gmail.modify",

	// Calendar - full access
	"https://www.googleapis.com/auth/calendar",

	// Drive - read-only
	"https://www.googleapis.com/auth/drive.readonly",

	// Docs - read-only
	"https://www.googleapis.com/auth/documents.readonly",

	// Sheets - read-only
	"https://www.googleapis.com/auth/spreadsheets.readonly",

	// Slides - read-only
	"https://www.googleapis.com/auth/presentations.readonly",
];

/** OAuth2 client configuration. */
export interface OAuth2Config {
	clientId: string;
	clientSecret: string;
	redirectUri?: string;
}

/**
 * Create an OAuth2 client.
 */
export function createOAuth2Client(config: OAuth2Config): OAuth2Client {
	return new OAuth2Client(
		config.clientId,
		config.clientSecret,
		config.redirectUri || "http://localhost",
	);
}

/**
 * Generate the authorization URL for the OAuth flow.
 */
export function getAuthUrl(client: OAuth2Client): string {
	return client.generateAuthUrl({
		access_type: "offline",
		scope: SCOPES,
		prompt: "consent", // Force consent to get refresh token
	});
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForTokens(
	client: OAuth2Client,
	code: string,
): Promise<Credentials> {
	const { tokens } = await client.getToken(code);
	client.setCredentials(tokens);
	return tokens;
}

/**
 * Set credentials on an OAuth2 client.
 */
export function setCredentials(
	client: OAuth2Client,
	credentials: Credentials,
): void {
	client.setCredentials(credentials);
}

/**
 * Refresh access token if expired.
 */
export async function refreshTokenIfNeeded(
	client: OAuth2Client,
): Promise<Credentials | null> {
	const credentials = client.credentials;

	// Check if token is expired or about to expire (within 5 minutes)
	if (credentials.expiry_date) {
		const expiryTime = credentials.expiry_date;
		const now = Date.now();
		const fiveMinutes = 5 * 60 * 1000;

		if (expiryTime - now < fiveMinutes) {
			// Token expired or expiring soon, refresh it
			const { credentials: newCredentials } = await client.refreshAccessToken();
			client.setCredentials(newCredentials);
			return newCredentials;
		}
	}

	return null;
}

/**
 * Get current credentials from client.
 */
export function getCredentials(client: OAuth2Client): Credentials {
	return client.credentials;
}

/**
 * OAuth2 authentication for Google Workspace APIs.
 * Uses OAuth 2.0 Device Flow for universal compatibility.
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
}

/** Device flow response from Google. */
export interface DeviceFlowResponse {
	device_code: string;
	user_code: string;
	verification_url: string;
	expires_in: number;
	interval: number;
}

/** Device flow token response. */
interface DeviceFlowTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
	scope: string;
}

/**
 * Create an OAuth2 client for device flow.
 */
export function createOAuth2Client(config: OAuth2Config): OAuth2Client {
	return new OAuth2Client(config.clientId, config.clientSecret);
}

/**
 * Initiate device flow by requesting a device code.
 */
export async function initiateDeviceFlow(
	config: OAuth2Config,
): Promise<DeviceFlowResponse> {
	const response = await fetch("https://oauth2.googleapis.com/device/code", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: config.clientId,
			scope: SCOPES.join(" "),
		}),
	});

	if (!response.ok) {
		const error = await response.text();

		// We check for an invalid client type error (wrong OAuth app type).
		if (error.includes("invalid_client")) {
			throw new Error(
				"Invalid OAuth client type. Your OAuth credentials must be created as " +
					"'TVs and Limited Input devices' (NOT Desktop app).\n\n" +
					"Please:\n" +
					"1. Go to https://console.cloud.google.com/apis/credentials\n" +
					"2. Delete your existing OAuth client\n" +
					"3. Create new credentials with type 'TVs and Limited Input devices'\n" +
					"4. Run /google-setup again with the new credentials",
			);
		}

		throw new Error(`Device flow initiation failed: ${error}`);
	}

	return (await response.json()) as DeviceFlowResponse;
}

/**
 * Poll for device flow authorization completion.
 * Returns credentials when user completes authorization.
 */
export async function pollForDeviceAuthorization(
	config: OAuth2Config,
	deviceCode: string,
	interval: number,
	signal?: AbortSignal,
): Promise<Credentials> {
	const pollInterval = (interval || 5) * 1000; // Convert to milliseconds

	while (!signal?.aborted) {
		// We wait before polling.
		await new Promise((resolve) => setTimeout(resolve, pollInterval));

		if (signal?.aborted) {
			throw new Error("Authorization cancelled");
		}

		try {
			const response = await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					client_id: config.clientId,
					client_secret: config.clientSecret,
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			});

			if (!response.ok) {
				const error = await response.json();

				// These errors mean we should keep polling
				if (
					error.error === "authorization_pending" ||
					error.error === "slow_down"
				) {
					continue;
				}

				// These errors mean authorization failed
				if (error.error === "expired_token") {
					throw new Error("Authorization code expired. Please try again.");
				}

				if (error.error === "access_denied") {
					throw new Error("Authorization denied by user.");
				}

				throw new Error(
					`Token exchange failed: ${error.error_description || error.error}`,
				);
			}

			// Success! Convert to Credentials format
			const tokenResponse = (await response.json()) as DeviceFlowTokenResponse;

			return {
				access_token: tokenResponse.access_token,
				refresh_token: tokenResponse.refresh_token,
				expiry_date: Date.now() + tokenResponse.expires_in * 1000,
				token_type: tokenResponse.token_type,
				scope: tokenResponse.scope,
			};
		} catch (error) {
			// If it's one of our thrown errors, re-throw
			if (error instanceof Error && error.message.includes("Authorization")) {
				throw error;
			}
		}
	}

	throw new Error("Authorization cancelled");
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

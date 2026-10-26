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
	let pollInterval = (interval || 5) * 1000; // Convert to milliseconds

	for (;;) {
		// We wait before polling, and giving up ends the wait, not the next poll.
		await pause(pollInterval, signal);

		let response: Response;
		try {
			response = await fetch("https://oauth2.googleapis.com/token", {
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
				signal,
			});
		} catch {
			// A network that dropped one poll may answer the next; a person
			// who gave up will not.
			if (signal?.aborted) throw cancelled(signal);
			continue;
		}

		if (!response.ok) {
			const error = await response.json();

			// These errors mean we should keep polling.
			if (error.error === "authorization_pending") continue;
			if (error.error === "slow_down") {
				// RFC 8628: every slow_down adds five seconds to the interval.
				pollInterval += SLOW_DOWN_MS;
				continue;
			}

			// Anything else is an answer that will not change by asking again,
			// which the old catch-all retried until the code expired.
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

		// The exchange succeeded, so we convert the response to our credentials format.
		const tokenResponse = (await response.json()) as DeviceFlowTokenResponse;

		return {
			access_token: tokenResponse.access_token,
			refresh_token: tokenResponse.refresh_token,
			expiry_date: Date.now() + tokenResponse.expires_in * 1000,
			token_type: tokenResponse.token_type,
			scope: tokenResponse.scope,
		};
	}
}

/** RFC 8628's increment for each `slow_down` answer. */
const SLOW_DOWN_MS = 5000;

/** Waits `ms`, or rejects with an `AbortError` as soon as `signal` fires. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) return Promise.reject(cancelled(signal));
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(cancelled(signal));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** The error a cancelled authorization rejects with. */
function cancelled(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason;
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	return new DOMException("Authorization cancelled", "AbortError");
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

	// We refresh proactively when the token is within 5 minutes of expiry.
	if (credentials.expiry_date) {
		const expiryTime = credentials.expiry_date;
		const now = Date.now();
		const fiveMinutes = 5 * 60 * 1000;

		if (expiryTime - now < fiveMinutes) {
			const { credentials: newCredentials } = await client.refreshAccessToken();
			client.setCredentials(newCredentials);
			return newCredentials;
		}
	}

	return null;
}

/**
 * Extract the current token credentials from an OAuth2 client.
 */
export function extractTokens(client: OAuth2Client): Credentials {
	return client.credentials;
}

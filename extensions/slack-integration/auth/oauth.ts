/**
 * Slack OAuth2 flow: web redirect with localhost callback.
 *
 * Slack user tokens (xoxp-) are long-lived and don't expire
 * unless explicitly revoked, so there's no refresh logic.
 * The flow:
 *   1. Redirect user to Slack's authorization URL
 *   2. Slack redirects back to localhost with a code
 *   3. Exchange code for an access token via oauth.v2.access
 */

import type { OAuthApp, StoredToken } from "../types.js";

/** Port for the local OAuth callback server. */
export const CALLBACK_PORT = 8766;

/** Redirect URI for the OAuth flow. */
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}`;

/**
 * OAuth scopes required for the extension.
 *
 * These are user-level scopes (requested via user_scope, not
 * bot scope) so the token acts as the authenticated user.
 */
export const SCOPES = [
	"search:read",
	"channels:read",
	"channels:history",
	"groups:read",
	"groups:history",
	"im:read",
	"im:history",
	"mpim:read",
	"mpim:history",
	"chat:write",
	"users:read",
	"users.profile:read",
	"reactions:read",
	"reactions:write",
];

/** Build the Slack OAuth authorization URL. */
export function buildAuthUrl(app: OAuthApp, state: string): string {
	const params = new URLSearchParams({
		client_id: app.clientId,
		user_scope: SCOPES.join(","),
		redirect_uri: REDIRECT_URI,
		state,
	});
	return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for a user access token.
 *
 * Calls Slack's oauth.v2.access endpoint and extracts the
 * user token from the authed_user field.
 */
export async function exchangeCodeForToken(
	app: OAuthApp,
	code: string,
): Promise<StoredToken> {
	const response = await fetch("https://slack.com/api/oauth.v2.access", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: app.clientId,
			client_secret: app.clientSecret,
			code,
			redirect_uri: REDIRECT_URI,
		}),
	});

	const body = (await response.json()) as Record<string, unknown>;

	if (!body.ok) {
		const error = (body.error as string) ?? "unknown_error";
		throw new Error(`Slack OAuth token exchange failed: ${error}`);
	}

	const authedUser = body.authed_user as Record<string, unknown> | undefined;
	if (!authedUser?.access_token) {
		throw new Error(
			"Slack OAuth response missing authed_user.access_token. " +
				"Make sure your app requests user_scope, not bot scope.",
		);
	}

	const team = body.team as Record<string, unknown> | undefined;

	return {
		accessToken: authedUser.access_token as string,
		userId: authedUser.id as string,
		teamId: (team?.id as string) ?? "",
		teamName: (team?.name as string) ?? undefined,
		scopes: (authedUser.scope as string) ?? SCOPES.join(","),
	};
}

/**
 * Google Workspace authentication: credential state and error
 * formatting.
 *
 * `ensureAuthenticated` itself, the interactive orchestration that
 * runs the setup wizard and/or device/web OAuth flow, needs a
 * host's UI and stays adapter-local; everything it is built from
 * (credential storage, the OAuth client, the callback server, the
 * browser opener, error formatting) lives here.
 */

export {
	clearAllConfig,
	getCredentials,
	getDefaultAccount,
	getOAuthApp,
	hasOAuthApp,
	listAccounts,
	type OAuthAppCredentials,
	saveAccount,
	setDefaultAccount,
	storeCredentials,
	storeOAuthApp,
} from "./credentials.ts";
export { AUTH_MESSAGES, formatAuthError } from "./errors.ts";

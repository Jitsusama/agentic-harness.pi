/**
 * Google Workspace authentication: credential state, error
 * formatting, and `ensureAuthenticated`, which runs the setup
 * wizard and the device or web sign-in when no account is ready.
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
export { ensureAuthenticated } from "./ensure-auth.ts";
export { AUTH_MESSAGES, formatAuthError } from "./errors.ts";

/**
 * Google Workspace authentication: one-call auth entry point,
 * credential state and error formatting.
 */

export {
	ensureAuthenticated,
	formatAuthError,
} from "./ensure-auth.js";
export {
	getCredentials,
	getDefaultAccount,
	listAccounts,
	type OAuthAppCredentials,
} from "./credentials.js";

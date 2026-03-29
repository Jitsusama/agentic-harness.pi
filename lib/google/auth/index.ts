/**
 * Google Workspace authentication: one-call auth entry point,
 * credential state and error formatting.
 */

export {
	getCredentials,
	getDefaultAccount,
	listAccounts,
	type OAuthAppCredentials,
} from "./credentials.js";
export {
	ensureAuthenticated,
	formatAuthError,
} from "./ensure-auth.js";

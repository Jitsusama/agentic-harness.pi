/**
 * Slack authentication: credential state, error formatting, and
 * `ensureAuthenticated`, which runs the setup wizard and the web
 * sign-in when no token is ready.
 */

export type { OAuthApp, StoredToken } from "../types.ts";
export {
	clearAllConfig,
	getOAuthApp,
	getToken,
	hasOAuthApp,
	hasToken,
	storeOAuthApp,
	storeToken,
} from "./credentials.ts";
export { ensureAuthenticated } from "./ensure-auth.ts";
export { formatAuthError } from "./errors.ts";

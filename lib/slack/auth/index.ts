/**
 * Slack authentication: one-call auth entry point,
 * credential state and error formatting.
 */

export type { OAuthApp, StoredToken } from "../types.js";
export { getToken, hasToken } from "./credentials.js";
export {
	ensureAuthenticated,
	formatAuthError,
} from "./ensure-auth.js";

/**
 * Slack authentication: one-call auth entry point,
 * credential state and error formatting.
 */

export {
	ensureAuthenticated,
	formatAuthError,
} from "./ensure-auth.js";
export { getToken, hasToken } from "./credentials.js";
export type { OAuthApp } from "../types.js";
export type { StoredToken } from "../types.js";

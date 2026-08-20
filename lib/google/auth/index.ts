/**
 * Google Workspace authentication: one-call auth entry point,
 * credential state and error formatting.
 *
 * Credential state and error formatting come from
 * agentic-harness.core, which owns everything about Google auth
 * that does not need a UI. `ensureAuthenticated` is the one piece
 * that does: it runs the setup wizard and/or device/web OAuth flow
 * against pi's own view/prompt primitives, so it stays here.
 */

export {
	formatAuthError,
	getCredentials,
	getDefaultAccount,
	listAccounts,
	type OAuthAppCredentials,
} from "@jitsusama/agentic-harness.core/google";
export { ensureAuthenticated } from "./ensure-auth.js";

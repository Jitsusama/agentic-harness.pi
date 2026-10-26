/**
 * Slack authentication: one-call auth entry point,
 * credential state and error formatting.
 *
 * Credential state and error formatting come from
 * agentic-harness.core, which owns everything about Slack auth that
 * does not need a UI. `ensureAuthenticated` is the one piece that
 * does: it runs the setup wizard and/or OAuth web redirect flow
 * against pi's own view/prompt primitives, so it stays here.
 */

export type {
	OAuthApp,
	StoredToken,
} from "../../core/slack/index.ts";
export {
	formatAuthError,
	getToken,
	hasToken,
} from "../../core/slack/index.ts";
export { ensureAuthenticated } from "./ensure-auth.ts";

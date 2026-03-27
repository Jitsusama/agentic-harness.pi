/**
 * Minimal session state for Slack user identity.
 *
 * Populated lazily on the first get_user call that resolves
 * to the authenticated user. Persisted across sessions so the
 * agent always knows who it's acting on behalf of.
 */

/** Session state: the authenticated user's Slack identity. */
export interface SlackSessionState {
	userId?: string;
	userHandle?: string;
}

/** Create empty session state. */
export function createSessionState(): SlackSessionState {
	return {};
}

/**
 * What the model is told about who it is on Slack.
 *
 * Every from: query the model writes depends on knowing the
 * authenticated handle, so this text is a contract with it rather
 * than decoration. It lives here, out of the event handler, because
 * a handler that builds its own payload inline cannot be checked.
 *
 * It is a standing context: frozen into the system prompt once it is
 * known, and said again only when it changes. It used to be a
 * message returned on every prompt, which put the same sentence into
 * the conversation every time the person typed: 31 times in one
 * session.
 */

import type { StandingContextWording } from "../../lib/prompt/index.ts";

/**
 * Names the identity's change messages, and with `-ledger` appended
 * the entry that records what the model has been told.
 */
export const IDENTITY_CONTEXT_TYPE = "slack-integration-identity";

/** Who the tool is authenticated as, as far as the model needs to know. */
export interface SlackIdentity {
	userHandle?: string;
	userId?: string;
}

/** How the identity reads in the system prompt and when it changes. */
export const IDENTITY_CONTEXT: StandingContextWording = {
	customType: IDENTITY_CONTEXT_TYPE,
	inPrompt: (text) => `\n\n${text}`,
	changed: (text) =>
		text ??
		"Slack is no longer signed in, so the Slack handle given earlier no longer applies.",
};

/**
 * Describe the authenticated user to the model, or say nothing.
 *
 * Nothing is the honest answer before sign-in: a handle invented for
 * the sake of having one would go straight into a from: query and
 * come back empty, which reads like an absence of messages rather
 * than an absence of credentials.
 */
export function identityText(identity: SlackIdentity): string | null {
	if (!identity.userHandle) return null;
	// The id is only mentioned when there is one. Interpolating it
	// unguarded put the literal string "undefined" in front of the
	// model, in parentheses, next to a real handle: an id-shaped
	// thing that is not an id, in the one message whose job is to
	// say who the caller is.
	const who = identity.userId
		? `@${identity.userHandle} (${identity.userId})`
		: `@${identity.userHandle}`;
	return (
		`The authenticated Slack user is ${who}. ` +
		"Use this handle for from: queries."
	);
}

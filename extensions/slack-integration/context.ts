/**
 * What the model is told about who it is on Slack.
 *
 * Every from: query the model writes depends on knowing the
 * authenticated handle, so this text is a contract with it rather
 * than decoration. It lives here, out of the event handler, because
 * a handler that builds its own payload inline cannot be checked.
 */

/**
 * Marker for the injected identity message.
 *
 * Names the message so pi can tell it from prose the user wrote.
 * It said it was there so a later turn could avoid adding a second
 * copy, which nothing does and nothing needs to: the hook returns
 * one message per turn and pi decides what to keep.
 */
export const IDENTITY_CONTEXT_TYPE = "slack-integration-identity";

/** Who the tool is authenticated as, as far as the model needs to know. */
export interface SlackIdentity {
	userHandle?: string;
	userId?: string;
}

/** An identity message pi will carry into the model's context. */
export interface IdentityContext {
	message: {
		customType: string;
		content: string;
		display: false;
	};
}

/**
 * Describe the authenticated user to the model, or say nothing.
 *
 * Nothing is the honest answer before sign-in: a handle invented for
 * the sake of having one would go straight into a from: query and
 * come back empty, which reads like an absence of messages rather
 * than an absence of credentials.
 */
export function identityContext(
	identity: SlackIdentity,
): IdentityContext | undefined {
	if (!identity.userHandle) return undefined;
	// The id is only mentioned when there is one. Interpolating it
	// unguarded put the literal string "undefined" in front of the
	// model, in parentheses, next to a real handle: an id-shaped
	// thing that is not an id, in the one message whose job is to
	// say who the caller is.
	const who = identity.userId
		? `@${identity.userHandle} (${identity.userId})`
		: `@${identity.userHandle}`;
	return {
		message: {
			customType: IDENTITY_CONTEXT_TYPE,
			content:
				`The authenticated Slack user is ${who}. ` +
				"Use this handle for from: queries.",
			// Context for the model, not a line for the user to read.
			display: false,
		},
	};
}

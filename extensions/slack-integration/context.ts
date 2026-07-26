/**
 * What the model is told about who it is on Slack.
 *
 * Every from: query the model writes depends on knowing the
 * authenticated handle, so this text is a contract with it rather
 * than decoration. It lives here, out of the event handler, because
 * a handler that builds its own payload inline cannot be checked.
 */

/**
 * Marker for the injected identity message, so a later turn can
 * recognize its own earlier context rather than adding a second copy.
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
	return {
		message: {
			customType: IDENTITY_CONTEXT_TYPE,
			content:
				`The authenticated Slack user is @${identity.userHandle}` +
				` (${identity.userId}). Use this handle for from: queries.`,
			// Context for the model, not a line for the user to read.
			display: false,
		},
	};
}

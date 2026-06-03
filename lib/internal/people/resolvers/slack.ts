/**
 * Built-in Slack person resolver.
 *
 * Looks an input handle up against Slack and returns an
 * identity with the Slack user id as a handle. Only runs
 * when the user is already authenticated with Slack (a
 * stored OAuth/session token is present on disk). Never
 * triggers the auth flow: the resolver must be silent and
 * idempotent.
 *
 * The resolver intentionally does no Slack API work for
 * obviously non-Slack inputs (full names with spaces,
 * obvious emails). Slack `resolveUser` accepts unprefixed
 * handles so a bullet like `**owner**: Joel Gerber.` would
 * search Slack for "Joel Gerber" — that's network traffic
 * we don't want by default. We require either a leading
 * `@` or a hint of `"handle"`.
 */

import type { Identity, PersonResolver } from "../../../people/types.js";
import { SlackClient } from "../../../slack/api/client.js";
import { getToken, hasToken } from "../../../slack/auth/credentials.js";
import { resolveUser } from "../../../slack/resolvers/user.js";

let cachedClient: SlackClient | undefined;

function clientFromStoredToken(): SlackClient | undefined {
	const token = getToken();
	if (!token?.accessToken) return undefined;
	if (!cachedClient) {
		cachedClient = new SlackClient(token.accessToken, token.cookie);
	}
	return cachedClient;
}

/** Reset the cached client. Tests only. */
export function clearSlackClientCache(): void {
	cachedClient = undefined;
}

function looksLikeHandle(input: string): boolean {
	if (input.startsWith("@")) return true;
	// A bare token with no spaces, dots or @ characters
	// that isn't an email could still be a slack handle,
	// but resolving it blindly invites bad guesses. We
	// require the `@` lead.
	return false;
}

export const slackResolver: PersonResolver = {
	id: "slack",
	priority: 100,
	async resolve(input, opts) {
		const hint = opts?.hint;
		if (hint && hint !== "handle") return undefined;
		if (!looksLikeHandle(input)) return undefined;
		if (!hasToken()) return undefined;
		const client = clientFromStoredToken();
		if (!client) return undefined;
		const handle = input.startsWith("@") ? input.slice(1) : input;
		try {
			const userId = await resolveUser(client, handle, opts?.signal);
			const identity: Identity = {
				id: handle.toLowerCase(),
				names: [handle],
				handles: [{ type: "slack", value: userId }],
			};
			return identity;
		} catch {
			return undefined;
		}
	},
};

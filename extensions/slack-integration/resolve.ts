/**
 * Turning the identifiers an action names (a permalink, a channel, a
 * timestamp, a person) into the typed conversation, message and user
 * its handler works with.
 */

import {
	resolveConversation,
	resolveTarget,
	resolveUser,
	type SlackClient,
} from "../../lib/slack/index.ts";
import {
	type ActionParams,
	type ResolvedParams,
	stringParam,
} from "../../lib/slack/types.ts";

/**
 * Resolve all identifiers from raw tool parameters.
 *
 * Runs before every handler so they receive typed objects
 * instead of raw strings. Resolution errors (unknown channel,
 * bad URL) propagate as exceptions to the caller.
 */
export async function resolveAllParams(
	client: SlackClient,
	params: ActionParams,
): Promise<ResolvedParams> {
	const resolved: ResolvedParams = {};

	const targetStr = stringParam(params, "target");
	const channelStr = stringParam(params, "channel");
	const tsStr = stringParam(params, "ts");
	const threadTsStr = stringParam(params, "thread_ts");
	const userStr = stringParam(params, "user");

	// Target (permalink or channel+ts) takes priority.
	if (targetStr || (channelStr && tsStr)) {
		try {
			resolved.target = await resolveTarget(
				client,
				targetStr,
				channelStr,
				tsStr,
			);
			if (threadTsStr) {
				resolved.target.threadTs = threadTsStr;
			}
			resolved.conversation = resolved.target.conversation;
		} catch {
			// Target resolution failed. Fall through to channel-only
			// resolution if channel was provided without ts.
			if (channelStr && !tsStr) {
				resolved.conversation = await resolveConversation(client, channelStr);
			}
			// If target was explicitly provided and failed, re-throw.
			else if (targetStr) {
				throw new Error(
					"Could not parse the target URL. Provide a valid Slack permalink, " +
						"or use the channel and ts parameters instead.",
				);
			}
		}
	}
	// Channel without ts: conversation-only resolution.
	else if (channelStr) {
		resolved.conversation = await resolveConversation(client, channelStr);
	}

	// User resolution.
	if (userStr) {
		resolved.userId = await resolveUser(client, userStr);
	}

	return resolved;
}

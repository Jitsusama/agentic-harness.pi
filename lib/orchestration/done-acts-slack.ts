/**
 * Reading the person's own Slack posts for the done-act judge
 * (done-acts.ts), as him, with the token the Slack tools sign in with.
 * Nothing here sends: it reads a channel's history, a thread's replies,
 * or, for a channel known only by its name, his messages there by search.
 */

import { SlackClient } from "../slack/api/client.ts";
import { getThread, listMessages } from "../slack/api/messages.ts";
import { searchMessages } from "../slack/api/search.ts";
import { getToken } from "../slack/auth/credentials.ts";
import { PROBE_WITHIN_MS, type SlackRead } from "./done-acts.ts";

/** The day before `oldest`, as Slack's search reads `after:`, which excludes its own day. */
function dayBefore(oldest: string): string {
	const at = new Date(Number(oldest) * 1000 - 86_400_000);
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/**
 * The person's Slack, as the judge reads it, or none while he isn't
 * signed in to it, which leaves every post unknown.
 */
export async function slackOfThePerson(): Promise<
	{ readonly me: string; readonly read: SlackRead } | undefined
> {
	const token = await getToken().catch(() => null);
	if (!token) return undefined;
	const client = new SlackClient(token.accessToken, token.cookie, {
		requestTimeoutMs: PROBE_WITHIN_MS,
	});
	const read: SlackRead = async (channel, thread, oldest) => {
		if (channel.startsWith("#")) {
			const found = await searchMessages(client, "", {
				channel,
				from: "me",
				after: dayBefore(oldest),
				limit: 50,
			});
			return found.messages;
		}
		const conversation = { id: channel, kind: "channel" as const };
		if (thread) {
			return getThread(client, { conversation, ts: thread }, { limit: 200 });
		}
		return listMessages(client, conversation, { oldest, limit: 200 });
	};
	return { me: token.userId, read };
}

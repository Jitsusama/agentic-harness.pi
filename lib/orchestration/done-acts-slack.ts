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
import {
	PROBE_WITHIN_MS,
	type SlackPost,
	type SlackRead,
} from "./done-acts.ts";

/** The day before `oldest`, as Slack's search reads `after:`, which excludes its own day. */
function dayBefore(oldest: string): string {
	const at = new Date(Number(oldest) * 1000 - 86_400_000);
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/**
 * The three ways the judge reads Slack, each stopped by `signal` once the
 * judge has given up on it, so a read held up by Slack's rate limit stops
 * retrying rather than spending the token his own Slack tools use.
 */
export interface SlackCalls {
	/** His messages in a channel known by its `#name`, after a day. */
	search(
		channel: string,
		after: string,
		signal: AbortSignal,
	): Promise<readonly SlackPost[]>;
	/** A thread's messages, its parent included. */
	thread(
		channel: string,
		ts: string,
		signal: AbortSignal,
	): Promise<readonly SlackPost[]>;
	/** A channel's top-level messages since `oldest`. */
	history(
		channel: string,
		oldest: string,
		signal: AbortSignal,
	): Promise<readonly SlackPost[]>;
}

/**
 * How the judge reads a place: a `#name` by search (Slack's history
 * wants an id), a thread by its replies, and a channel by its history.
 */
export function slackReadWith(calls: SlackCalls): SlackRead {
	return async (channel, thread, oldest) => {
		const signal = AbortSignal.timeout(PROBE_WITHIN_MS);
		if (channel.startsWith("#")) {
			return calls.search(channel, dayBefore(oldest), signal);
		}
		if (thread) return calls.thread(channel, thread, signal);
		return calls.history(channel, oldest, signal);
	};
}

/** How long a sign-in, or its absence, is kept before the keyring is read again. */
const SIGN_IN_KEPT_MS = 10 * 60_000;

let signedIn:
	| {
			readonly at: number;
			readonly reader: Promise<
				{ readonly me: string; readonly read: SlackRead } | undefined
			>;
	  }
	| undefined;

/** The person's Slack read through his token. */
async function signIn(): Promise<
	{ readonly me: string; readonly read: SlackRead } | undefined
> {
	const token = await getToken().catch(() => null);
	if (!token) return undefined;
	const client = new SlackClient(token.accessToken, token.cookie, {
		requestTimeoutMs: PROBE_WITHIN_MS,
	});
	const conversation = (id: string) => ({ id, kind: "channel" as const });
	const read = slackReadWith({
		search: async (channel, after, signal) =>
			(
				await searchMessages(client, "", {
					channel,
					from: "me",
					after,
					limit: 50,
					signal,
				})
			).messages,
		thread: (channel, ts, signal) =>
			getThread(
				client,
				{ conversation: conversation(channel), ts },
				{ limit: 200, signal },
			),
		history: (channel, oldest, signal) =>
			listMessages(client, conversation(channel), {
				oldest,
				limit: 200,
				signal,
			}),
	});
	return { me: token.userId, read };
}

/**
 * The person's Slack, as the judge reads it, or none while he isn't
 * signed in to it, which leaves every post unknown. The keyring is read
 * once in {@link SIGN_IN_KEPT_MS}, so a locked one asks him at most
 * that often, never on every send.
 */
export function slackOfThePerson(): Promise<
	{ readonly me: string; readonly read: SlackRead } | undefined
> {
	const now = Date.now();
	if (!signedIn || now - signedIn.at > SIGN_IN_KEPT_MS) {
		signedIn = { at: now, reader: signIn().catch(() => undefined) };
	}
	return signedIn.reader;
}

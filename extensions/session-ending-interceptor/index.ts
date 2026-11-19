/**
 * Session Ending Interceptor: no ask of the person to end a machine's
 * sessions while others are live there.
 *
 * A log-out, reboot, restart, shutdown or switch of users ends every pi
 * session on the machine, busy or idle. On 18 November a session asked
 * Joel to log out on equilibrius and five sessions ended mid-run. So an
 * `ask`, a `show_person` look or a reply asking for one is refused while
 * the machine's mycelium node says any session other than the asker's
 * is there in any state but ended, and refused when the node can't be
 * read, under the no-session-ending-ask-while-live guard.
 *
 * A call is refused before it runs. A reply has already streamed by the
 * time pi finalizes it, so its text is replaced there, which pi shows
 * in its place and keeps in the session, with its tool calls left as
 * they were; the reason follows as a message that keeps the run going,
 * so the model says something else.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { thisMachine } from "../../lib/internal/machine/machine.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { nodeSessionsAt, nodeSocket } from "../../lib/mesh/node.ts";
import {
	refusalFor,
	type Said,
	type SessionEndingDeps,
	saidByAsk,
	saidByLook,
	saidInReply,
} from "./refuse.ts";

export type { SessionEndingDeps } from "./refuse.ts";

const GUARD = GUARDS.noSessionEndingAskWhileLive;

/** What the refusal of a reply is sent as, after the withheld reply. */
export const WITHHELD_MESSAGE = "session-ending-withheld";

/** What stands in a withheld reply's place. */
const WITHHELD =
	"(Withheld: this asked the person to end a machine's sessions. The reason follows.)";

/** What reads the tool calls and replies that say something to the person. */
const READERS: Readonly<Record<string, (input: unknown) => Said>> = {
	ask: saidByAsk,
	show_person: saidByLook,
};

/** The interceptor, reading the node and the machine through `deps`. */
export function sessionEndingInterceptor(deps: SessionEndingDeps) {
	return (pi: ExtensionAPI): void => {
		declareGuards(GUARD);
		pi.on("tool_call", (event, ctx) =>
			refuseCall(event.toolName, event.input, ctx, deps),
		);
		pi.on("message_end", (event, ctx) =>
			withholdReply(pi, event.message, ctx, deps),
		);
	};
}

export default sessionEndingInterceptor({
	sessions: () => nodeSessionsAt(nodeSocket()),
	here: () => thisMachine(),
});

async function refuseCall(
	toolName: string,
	input: unknown,
	ctx: ExtensionContext,
	deps: SessionEndingDeps,
) {
	const read = READERS[toolName];
	if (!read) return undefined;
	const reason = await refusalFor(read(input), selfOf(ctx), deps);
	if (!reason) return undefined;
	return refusalUnder(
		GUARD.name,
		{ block: true, reason },
		"An ask to end a machine's sessions",
		JSON.stringify(input),
	);
}

/**
 * The reply with its text withheld, when it asks to end sessions the
 * node says are live; nothing, leaving it as it was, otherwise.
 */
async function withholdReply<M extends { role: string }>(
	pi: ExtensionAPI,
	message: M,
	ctx: ExtensionContext,
	deps: SessionEndingDeps,
): Promise<{ message: M } | undefined> {
	if (message.role !== "assistant" || !("content" in message)) return undefined;
	const said = saidInReply(message.content);
	const reason = await refusalFor(said, selfOf(ctx), deps);
	if (!reason) return undefined;
	const verdict = refusalUnder(
		GUARD.name,
		{ block: true, reason },
		"A reply asking to end a machine's sessions",
		said.prose.join("\n"),
	);
	if (!verdict) return undefined;
	const stopped =
		"stopReason" in message &&
		(message.stopReason === "aborted" || message.stopReason === "error");
	if (!stopped) {
		pi.sendMessage(
			{
				customType: WITHHELD_MESSAGE,
				content: `Your last reply was withheld from the person. ${verdict.reason} Say what you meant without the ask.`,
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}
	return { message: { ...message, content: withheld(message.content) } };
}

/** A reply's content with its text in one notice, the rest kept. */
function withheld(content: unknown): unknown[] {
	const blocks: unknown[] = Array.isArray(content) ? content : [];
	let noted = false;
	return blocks.flatMap((block) => {
		if (!isRecord(block) || block.type !== "text") return [block];
		if (noted) return [];
		noted = true;
		return [{ type: "text", text: WITHHELD }];
	});
}

/** The asker's own session, which its ask doesn't end for anyone else. */
function selfOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		// A context without a session (a stand-in, or one torn down)
		// names none, so no session is taken for the asker's.
		return undefined;
	}
}

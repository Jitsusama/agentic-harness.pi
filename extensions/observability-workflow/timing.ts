/**
 * Each model call's timing, and each message the person typed, kept in
 * the session's own log as entries the model is never sent.
 *
 * pi's log says when a call's request started and how long it ran, but
 * not when its first token came, nor which user messages were typed
 * rather than sent by an extension, a steer or the mesh (7QEY1S, 12
 * November, for the latency pass). So after each assistant message the
 * log gains a `harness-call` entry, and at each typed message a
 * `harness-typed` one.
 *
 * pi hands an assistant's message_end to extensions before it saves the
 * message, so a call's entry lands just before the message it times,
 * and names it by the request's start, the message's own `timestamp`.
 * A typed entry lands at Enter, before the message it marks; a message
 * typed while a run goes on is saved only when it is delivered, so the
 * entry says how it was queued, and its length to match it by.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";

/** The custom type of a model call's timing entry. */
export const CALL_ENTRY = "harness-call";

/** The custom type of the entry marking a typed message. */
export const TYPED_ENTRY = "harness-typed";

/** One model call's timing, as its entry keeps it. */
interface CallTiming {
	readonly v: 1;
	/** The request's start, as the assistant message's `timestamp` (ms). */
	readonly of: number;
	/** When the turn began, before the harness prepared the request. */
	readonly turnAt: string;
	/** From the turn's start to the request's: the harness's own share. */
	readonly preparedMs: number;
	/** From the request's start to its first streamed token, when one came. */
	readonly firstTokenMs?: number;
	/** From the request's start to its end, as pi measured it. */
	readonly durationMs?: number;
	readonly stopReason: AssistantMessage["stopReason"];
}

/** A typed message, as its entry keeps it. */
interface Typed {
	readonly v: 1;
	/** When the person pressed Enter. */
	readonly at: string;
	/** Typed in the terminal, or sent by a client over RPC. */
	readonly source: "interactive" | "rpc";
	/** How a message typed mid-run was queued; none when typed idle. */
	readonly queued?: "steer" | "followUp";
	/** The message's length, to match it to the user message saved later. */
	readonly chars: number;
}

/** A call under way: when its turn began, and its first token. */
interface Under {
	readonly turnAt: number;
	firstTokenAt?: number;
}

/** Keep every model call's timing and every typed message in the log. */
export function timeCalls(pi: ExtensionAPI): void {
	let under: Under | undefined;
	pi.on("turn_start", async () => {
		under = { turnAt: Date.now() };
	});
	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant" && under && !under.firstTokenAt)
			under.firstTokenAt = Date.now();
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant" || !under) return;
		pi.appendEntry(CALL_ENTRY, callTiming(event.message, under));
		under = undefined;
	});
	pi.on("input", async (event) => {
		const typed = typedOf(event, new Date());
		if (typed) pi.appendEntry(TYPED_ENTRY, typed);
		return { action: "continue" as const };
	});
}

/** A finished call's timing, from its message and what was seen of it. */
function callTiming(
	message: AssistantMessage,
	seen: { readonly turnAt: number; readonly firstTokenAt?: number },
): CallTiming {
	return {
		v: 1,
		of: message.timestamp,
		turnAt: new Date(seen.turnAt).toISOString(),
		preparedMs: Math.max(0, message.timestamp - seen.turnAt),
		...(seen.firstTokenAt === undefined
			? {}
			: { firstTokenMs: Math.max(0, seen.firstTokenAt - message.timestamp) }),
		...(message.durationMs === undefined
			? {}
			: { durationMs: message.durationMs }),
		stopReason: message.stopReason,
	};
}

/** A message the person typed, or nothing for one an extension sent. */
function typedOf(
	event: Pick<InputEvent, "source" | "text" | "streamingBehavior">,
	now: Date,
): Typed | undefined {
	if (event.source === "extension") return undefined;
	return {
		v: 1,
		at: now.toISOString(),
		source: event.source,
		...(event.streamingBehavior ? { queued: event.streamingBehavior } : {}),
		chars: event.text.length,
	};
}

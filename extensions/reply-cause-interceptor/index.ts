/**
 * Reply Cause Interceptor: a reply to the person that states why
 * something happened as settled fact, with no test behind it, is
 * followed by a note telling the model to say what it is.
 *
 * The mesh refuses such a message before it goes; a reply has already
 * streamed to the person by the time pi finalizes it, and judging takes
 * up to a few seconds, so the reply is never held. Once judged, the
 * model is sent one note quoting the part, as a follow-up that starts a
 * turn of its own, and tells the person whether it is a hypothesis or
 * what tested it. Only a finished reply is judged: one pi stopped for
 * good with nothing left to call, text alone. The reply answering the
 * note is not judged, so a note can't follow a note, and none is sent
 * once the person has typed since, since the reply is behind them.
 *
 * It is the `untested-cause` guard, the mesh's: set `off`, nothing is
 * judged and no text goes to the classifier's provider. Otherwise every
 * finished reply's text goes there. With no classifier, an error or a
 * slow answer, nothing is judged.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type FoundClassifier,
	findClassifier,
} from "../../lib/classifier/jev.ts";
import { guardMode } from "../../lib/guardian/policy.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { isRecord } from "../../lib/internal/record.ts";
import {
	untestedCauseReason,
	untestedCausesFound,
} from "../../lib/prose/claims.ts";

const GUARD = GUARDS.untestedCause;

/** What the note after a judged reply is sent as. */
export const UNTESTED_REPLY_MESSAGE = "reply-untested-cause";

/** What the interceptor reads through, so a test can stand in for each. */
export interface ReplyCauseDeps {
	/** The classifier to judge with, found once per session. */
	readonly classifier: (
		ctx: Pick<ExtensionContext, "modelRegistry">,
	) => Promise<FoundClassifier>;
	/** Told of each judgment as it starts, so a test can wait on it. */
	readonly judging?: (judgment: Promise<void>) => void;
}

/**
 * What the session has heard: how often the person has spoken, so a
 * judgment begun before they spoke sends nothing; and whether a note is
 * out, so the reply answering it goes unjudged.
 */
interface Heard {
	spoken: number;
	noteOut: boolean;
	lookup?: Promise<FoundClassifier>;
}

/** The interceptor, finding its classifier through `deps`. */
export function replyCauseInterceptor(deps: ReplyCauseDeps) {
	return (pi: ExtensionAPI): void => {
		declareGuards(GUARD);
		const heard: Heard = { spoken: 0, noteOut: false };
		pi.on("input", (event) => {
			// An extension's message, a job's result or a peer's nudge, is
			// no word of the person's.
			if (event.source === "extension") return;
			heard.spoken += 1;
			heard.noteOut = false;
		});
		pi.on("message_end", (event, ctx) => {
			const text = finishedReplyText(event.message);
			if (text === undefined) return;
			if (heard.noteOut) {
				heard.noteOut = false;
				return;
			}
			if (guardMode(GUARD.name) === "off") return;
			heard.lookup ??= deps.classifier(ctx);
			const judgment = noteUntested(pi, text, heard, heard.lookup);
			deps.judging?.(judgment);
		});
	};
}

/**
 * Judges `text` and, when a part states an untested cause and the person
 * hasn't spoken since, sends the model its note.
 */
async function noteUntested(
	pi: ExtensionAPI,
	text: string,
	heard: Heard,
	lookup: Promise<FoundClassifier>,
): Promise<void> {
	const spoken = heard.spoken;
	const found = await untestedCausesFound(text, lookup);
	if (found.length === 0 || heard.spoken !== spoken) return;
	heard.noteOut = true;
	pi.sendMessage(
		{
			customType: UNTESTED_REPLY_MESSAGE,
			content: [
				"Your last reply was judged after the person read it.",
				untestedCauseReason(found),
				"Tell the person in a line which it is.",
			].join(" "),
			display: true,
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

/**
 * A finished reply's text: an assistant message pi stopped for good,
 * with no tool call left to run, its text blocks joined. Anything else,
 * a reply cut off or one still calling tools, has none.
 */
function finishedReplyText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	if (message.stopReason !== "stop") return undefined;
	const blocks: unknown[] = Array.isArray(message.content)
		? message.content
		: [];
	if (blocks.some((block) => isRecord(block) && block.type === "toolCall")) {
		return undefined;
	}
	const text = blocks
		.flatMap((block) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n\n")
		.trim();
	return text === "" ? undefined : text;
}

export default replyCauseInterceptor({
	classifier: (ctx) =>
		findClassifier(ctx, undefined, "the untested-cause guard"),
});

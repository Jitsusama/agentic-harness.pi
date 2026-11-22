/**
 * Reply Cause Interceptor: a reply to the person that states why
 * something happened as settled fact, with no test behind it, is
 * followed by a note telling the model to say what it is.
 *
 * The mesh refuses such a message before it goes; a reply has already
 * streamed to the person by the time pi settles, and judging takes up
 * to a few seconds, so the reply is never held. Once pi settles after
 * a run the person's own words began, its last reply is judged, text
 * alone, code blocks left out. A part stating an untested cause sends
 * the model one note quoting it, as an automated turn, and the model
 * tells the person whether it is a hypothesis or what tested it. The
 * run answering the note is not judged, so a note can't follow a note,
 * and none is sent once anything has come since, since the reply is
 * then behind them.
 *
 * It is the `untested-cause` guard, the mesh's, and reads the mesh's
 * classifier setting: with the guard `off` or `PI_MESH_CLASSIFIER=off`
 * nothing is judged and no text goes to the classifier's provider.
 * Otherwise each judged reply's text goes there. With no classifier,
 * an error or a slow answer, nothing is said.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CLASSIFIER_ENV,
	type FoundClassifier,
	findClassifier,
} from "../../lib/classifier/jev.ts";
import { guardMode } from "../../lib/guardian/policy.ts";
import { automatedText } from "../../lib/internal/automated.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { isPersonsOwnText } from "../../lib/internal/session/driven.ts";
import {
	untestedCauseReason,
	untestedCausesFound,
} from "../../lib/prose/claims.ts";

const GUARD = GUARDS.untestedCause;

/** Why the note's automated turn was started, as its header says. */
export const NOTE_REASON =
	"a reply to the person was judged after they read it";

/** A fenced code block, which quotes rather than says. */
const FENCED = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm;

/** What the interceptor reads through, so a test can stand in for each. */
export interface ReplyCauseDeps {
	/** The classifier to judge with, looked up until one is found. */
	readonly classifier: (
		ctx: Pick<ExtensionContext, "modelRegistry">,
	) => Promise<FoundClassifier>;
	/** Told of each judgment as it starts, so a test can wait on it. */
	readonly judging?: (judgment: Promise<void>) => void;
}

/** What a settle needs of pi's context. */
type SettledContext = Pick<
	ExtensionContext,
	"modelRegistry" | "hasUI" | "isIdle"
>;

/**
 * What the session has heard since pi last settled: whether the
 * person's own words came, and the last finished reply; how often
 * anything has come at all, so a judgment knows it was overtaken; and
 * the classifier once found.
 */
interface Heard {
	personSpoke: boolean;
	reply?: string;
	moved: number;
	lookup?: Promise<FoundClassifier>;
}

/** The interceptor, finding its classifier through `deps`. */
export function replyCauseInterceptor(deps: ReplyCauseDeps) {
	return (pi: ExtensionAPI): void => {
		declareGuards(GUARD);
		const heard: Heard = { personSpoke: false, moved: 0 };
		pi.on("input", (event) => hearInput(heard, event.text));
		pi.on("agent_start", () => {
			heard.moved += 1;
		});
		pi.on("agent_end", (event) => keepLastReply(heard, event.messages));
		pi.on("agent_settled", (event, ctx) =>
			judgeSettledReply(pi, deps, heard, event.aborted, ctx),
		);
	};
}

/**
 * Notes what came in. The person's own words make the run a reply to
 * them; an automated turn, a note's among them, a peer's steer or a
 * job's result is no word of theirs, so the run a note starts goes
 * unjudged and a note can't follow a note.
 */
function hearInput(heard: Heard, text: string): void {
	heard.moved += 1;
	if (isPersonsOwnText(text)) heard.personSpoke = true;
}

/**
 * Keeps the last reply of a run that just ended, when it is finished.
 * The run's messages are the ones the session keeps, so a reply another
 * extension replaced, one withheld among them, is read as replaced.
 */
function keepLastReply(heard: Heard, messages: readonly unknown[]): void {
	const replies = messages.filter(
		(message) => isRecord(message) && message.role === "assistant",
	);
	heard.reply = finishedReplyText(replies.at(-1));
}

/**
 * Once pi settles, starts judging the last reply when the person's own
 * words came in its runs and the guard is on; never waiting for the
 * judgment. Print and JSON runs have no person reading.
 */
function judgeSettledReply(
	pi: ExtensionAPI,
	deps: ReplyCauseDeps,
	heard: Heard,
	aborted: boolean,
	ctx: SettledContext,
): void {
	const { reply, personSpoke } = heard;
	heard.reply = undefined;
	heard.personSpoke = false;
	if (aborted || !personSpoke || !ctx.hasUI) return;
	if (reply === undefined || guardMode(GUARD.name) === "off") return;
	const said = reply.replace(FENCED, "").trim();
	if (said === "") return;
	const judgment = noteUntested(
		pi,
		said,
		heard,
		lookupOf(heard, deps, ctx),
		ctx,
	);
	deps.judging?.(judgment);
}

/**
 * The classifier, looked up once it is found or switched off. A lookup
 * that failed is looked up again at the next reply, so a login later
 * on starts the judging.
 */
function lookupOf(
	heard: Heard,
	deps: ReplyCauseDeps,
	ctx: SettledContext,
): Promise<FoundClassifier> {
	heard.lookup ??= Promise.resolve()
		.then(() => deps.classifier(ctx))
		.then(
			(found) => {
				if (!found.ok && !found.off) heard.lookup = undefined;
				return found;
			},
			(error: unknown): FoundClassifier => {
				heard.lookup = undefined;
				const why = error instanceof Error ? error.message : String(error);
				return { ok: false, reason: `finding the classifier failed: ${why}` };
			},
		);
	return heard.lookup;
}

/**
 * Judges `text` and, when a part states an untested cause and nothing
 * has come since, starts the model's turn with its note. It is headed
 * as automated, as every turn the harness starts itself is, so nobody
 * reads it as the person's, and its run is no reply to them.
 */
async function noteUntested(
	pi: ExtensionAPI,
	text: string,
	heard: Heard,
	lookup: Promise<FoundClassifier>,
	ctx: SettledContext,
): Promise<void> {
	const moved = heard.moved;
	try {
		const found = await untestedCausesFound(text, lookup);
		if (found.length === 0 || heard.moved !== moved || !ctx.isIdle()) return;
		pi.sendUserMessage(
			automatedText(
				NOTE_REASON,
				[
					"The classifier flagged a part of your last reply, which the person has read.",
					untestedCauseReason(found),
					"Tell the person in a line which it is.",
				].join("\n"),
			),
		);
	} catch {
		// A judgment that failed, or a pi a reload replaced since, sends
		// nothing: a missed note costs less than an error in the session.
	}
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

/** The classifier the mesh's setting names, or none when it is `off`. */
export function replyClassifier(
	env: NodeJS.ProcessEnv,
): ReplyCauseDeps["classifier"] {
	return (ctx) => findClassifier(ctx, env[CLASSIFIER_ENV], CLASSIFIER_ENV);
}

export default replyCauseInterceptor({
	classifier: replyClassifier(process.env),
});

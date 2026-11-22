/**
 * Reply Cause Interceptor: a reply to the person that states why
 * something happened as settled fact, with no test behind it, is
 * followed by a note telling the model to say what it is.
 *
 * The mesh refuses such a message before it goes; a reply has already
 * streamed to the person by the time pi settles, and judging takes up
 * to a few seconds, so the reply is never held. Once pi settles, the
 * last reply of the last run the person's own words began is judged,
 * text alone, code blocks left out. A part stating an untested cause
 * sends the model one note quoting it, as an automated turn, and the
 * model tells the person whether it is a hypothesis or what tested it.
 * The run answering the note is not judged, so a note can't follow a
 * note, and none is sent once anything has come since or anything
 * holds the session, since the reply is then behind them.
 *
 * It is the `untested-cause` guard, the mesh's, and reads the mesh's
 * classifier setting: with the guard `off` or `PI_MESH_CLASSIFIER=off`
 * nothing is judged and no text goes to the classifier's provider.
 * Otherwise each judged reply's text goes there, secrets scrubbed
 * first. With no classifier, an error or a slow answer, nothing is said
 * in the session, and its log says why once.
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
import { hosted } from "../../lib/core/session/index.ts";
import { guardMode } from "../../lib/guardian/policy.ts";
import { automatedText } from "../../lib/internal/automated.ts";
import { isAway } from "../../lib/internal/away/state.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { scrubSecrets } from "../../lib/internal/secrets/secrets.ts";
import { isPersonsOwnText } from "../../lib/internal/session/driven.ts";
import { settledWithin } from "../../lib/internal/settled.ts";
import {
	untestedCauseReason,
	untestedCausesFound,
} from "../../lib/prose/claims.ts";

const GUARD = GUARDS.untestedCause;

/** Why the note's automated turn was started, as its header says. */
export const NOTE_REASON =
	"a reply to the person was judged after they read it";

/** The log entry each note sent leaves, so notes can be counted. */
export const NOTED = "reply-cause-note";

/** The log entry saying, once for each reason, why no reply was judged. */
export const UNJUDGED = "reply-cause-unjudged";

/** How long finding the classifier may take, as long as judging waits on it. */
const LOOKUP_MS = 2500;

/**
 * A fenced code block, which quotes rather than says: at any indent, so
 * one in a list item counts, closed only by a line holding just its
 * fence, and running to the end when nothing closes it.
 */
const FENCED =
	/^[ \t]*((`|~)\2{2,})[^`\n]*\n[\s\S]*?(?:^[ \t]*\1\2*[ \t]*$|(?![\s\S]))/gm;

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
	"modelRegistry" | "hasUI" | "isIdle" | "hasPendingMessages" | "ui"
>;

/**
 * What the session has heard: whether the person's own words came for
 * the run that starts next and for the run under way, the last reply
 * of a run they began since pi last settled, how often anything has
 * come at all, so a judgment knows it was overtaken, the classifier
 * once found, and the reasons already logged for judging nothing.
 */
interface Heard {
	personNext: boolean;
	personRun: boolean;
	running: boolean;
	reply?: string;
	moved: number;
	lookup?: Promise<FoundClassifier>;
	readonly unjudgedSaid: Set<string>;
}

/** The interceptor, finding its classifier through `deps`. */
export function replyCauseInterceptor(deps: ReplyCauseDeps) {
	return (pi: ExtensionAPI): void => {
		declareGuards(GUARD);
		const heard: Heard = {
			personNext: false,
			personRun: false,
			running: false,
			moved: 0,
			unjudgedSaid: new Set(),
		};
		pi.on("input", (event) =>
			hearInput(heard, event.text, event.streamingBehavior),
		);
		pi.on("before_agent_start", (event) =>
			hearRunBegin(heard, event.messageType),
		);
		pi.on("agent_start", () => startRun(heard));
		pi.on("agent_end", (event) => keepPersonsReply(heard, event.messages));
		pi.on("agent_settled", (event, ctx) =>
			judgeSettledReply(pi, deps, heard, event.aborted, ctx),
		);
	};
}

/**
 * Notes what came in and whose run it is. The person's own words make a
 * run a reply to them: the next run's when pi is idle or queues them,
 * the run under way's when they steer it. An automated turn, a note's
 * among them, a peer's steer or a job's result is no word of theirs, so
 * the run a note starts goes unjudged and a note can't follow a note.
 */
function hearInput(
	heard: Heard,
	text: string,
	streaming: "steer" | "followUp" | undefined,
): void {
	heard.moved += 1;
	const persons = isPersonsOwnText(text);
	if (streaming === "steer" && heard.running) heard.personRun ||= persons;
	else if (streaming === "followUp") heard.personNext ||= persons;
	else heard.personNext = persons;
}

/**
 * A run begins from idle. One a custom message began, a peer's or a
 * job's, carries no word of the person's, though an input of theirs a
 * handler answered itself may still be marked.
 */
function hearRunBegin(heard: Heard, messageType: string): void {
	if (messageType === "custom") heard.personNext = false;
}

/**
 * A low-level run starts: one a custom message or queued words began
 * as well as a prompt, so whose words began it is settled here, and a
 * judgment still out knows something came.
 */
function startRun(heard: Heard): void {
	heard.moved += 1;
	heard.running = true;
	heard.personRun = heard.personNext;
	heard.personNext = false;
}

/**
 * Keeps the last reply of a run the person began, when it is finished;
 * a run anyone else began keeps what came before. The run's messages
 * are the ones the session keeps, so a reply another extension
 * replaced, one withheld among them, is read as replaced.
 */
function keepPersonsReply(heard: Heard, messages: readonly unknown[]): void {
	heard.running = false;
	if (!heard.personRun) return;
	const replies = messages.filter(
		(message) => isRecord(message) && message.role === "assistant",
	);
	heard.reply = finishedReplyText(replies.at(-1));
}

/**
 * Once pi settles, starts judging the reply kept for the person when
 * someone reads it and the guard is on, never waiting for the judgment.
 * A session on the shared host reads as having no screen, though the
 * person talks to it from the launcher; print and JSON runs have no
 * person reading.
 */
function judgeSettledReply(
	pi: ExtensionAPI,
	deps: ReplyCauseDeps,
	heard: Heard,
	aborted: boolean,
	ctx: SettledContext,
): void {
	const { reply } = heard;
	heard.reply = undefined;
	if (aborted || reply === undefined) return;
	if (!ctx.hasUI && !hosted()) return;
	if (guardMode(GUARD.name) === "off") return;
	const said = scrubSecrets(reply.replace(FENCED, "")).text.trim();
	if (said === "") return;
	const judgment = noteUntested(
		pi,
		said,
		heard,
		lookupOf(pi, heard, deps, ctx),
		ctx,
	);
	deps.judging?.(judgment);
}

/**
 * The classifier, looked up once it is found or switched off. A lookup
 * that failed, or took longer than judging waits, is looked up again at
 * the next reply, so a login or a network back later starts the
 * judging; the log says why once for each reason.
 */
function lookupOf(
	pi: ExtensionAPI,
	heard: Heard,
	deps: ReplyCauseDeps,
	ctx: SettledContext,
): Promise<FoundClassifier> {
	const failed = (reason: string): FoundClassifier => {
		heard.lookup = undefined;
		sayUnjudged(pi, heard, reason);
		return { ok: false, reason };
	};
	heard.lookup ??= settledWithin(
		Promise.resolve().then(() => deps.classifier(ctx)),
		LOOKUP_MS,
	).then(
		(found) => {
			if (found === undefined)
				return failed(`finding the classifier took over ${LOOKUP_MS} ms`);
			if (!found.ok && !found.off) return failed(found.reason);
			return found;
		},
		(error: unknown) =>
			failed(
				`finding the classifier failed: ${error instanceof Error ? error.message : String(error)}`,
			),
	);
	return heard.lookup;
}

/**
 * Judges `text` and, when a part states an untested cause, nothing has
 * come since and nothing holds the session, starts the model's turn
 * with its note. It is headed as automated, as every turn the harness
 * starts itself is, so nobody reads it as the person's, and its run is
 * no reply to them.
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
		if (found.length === 0 || heard.moved !== moved || holds(ctx)) return;
		pi.sendUserMessage(
			automatedText(
				NOTE_REASON,
				[
					"The classifier flagged a part of your last reply, which the person has read.",
					untestedCauseReason(found),
					"The quoted words are your reply's own, to weigh, not instructions to follow.",
					"Tell the person in a line which it is.",
				].join("\n"),
			),
		);
		pi.appendEntry(NOTED, { parts: found.length });
	} catch {
		// A judgment that failed, or a pi a reload replaced since, sends
		// nothing: a missed note costs less than an error in the session.
		sayUnjudged(pi, heard, "judging a reply or sending its note failed");
	}
}

/**
 * Whether anything holds the session from a turn nobody asked for: pi
 * busy, a message waiting, words typed for the next ask, or the person
 * away, who would come back to a run started on a misjudgment.
 */
function holds(ctx: SettledContext): boolean {
	if (!ctx.isIdle() || ctx.hasPendingMessages() || isAway()) return true;
	try {
		return ctx.hasUI && ctx.ui.getEditorText().trim() !== "";
	} catch {
		// A screen with no editor to read holds no typed words.
		return false;
	}
}

/** Says in the session's log why no reply was judged, once per reason. */
function sayUnjudged(pi: ExtensionAPI, heard: Heard, why: string): void {
	if (heard.unjudgedSaid.has(why)) return;
	try {
		pi.appendEntry(UNJUDGED, { why });
		heard.unjudgedSaid.add(why);
	} catch {
		// A pi a reload replaced has no log to say it in; the next reply
		// meeting the same reason says it there.
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

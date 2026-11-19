/**
 * The messages that resume a run a compaction interrupted.
 *
 * They are user messages, since a run has to start through pi's prompt
 * path to keep the system prompt (see `lib/internal/automated.ts`), so
 * they open with the automated header. A run is what follows one typed
 * message, and anything reading the log tells these apart by that
 * header, or by the opening they had before it.
 */

import { automatedHeader, automatedText } from "../internal/automated.ts";
import { isRecord } from "../internal/record.ts";

const CARRY_ON =
	"Carry on with what you were working on, from where you left off.";

/** Why a resume after a compaction landed was sent. */
const COMPACTED = "the context was compacted to keep this session affordable";

/** Why a resume after a compaction failed was sent. */
const FAILED = "compacting the context failed, so it was left as it is";

/** Sent once a compaction lands, to carry on the run it stopped. */
export const RESUME_TEXT = automatedText(COMPACTED, CARRY_ON);

/** Sent once a compaction fails, to carry on the run it stopped. */
export const FAILED_RESUME_TEXT = automatedText(FAILED, CARRY_ON);

/**
 * How each opens, today and before the header. A message is matched
 * on its opening rather than as a whole, since other extensions may
 * append their own context to a message on its way into the log.
 */
const OPENINGS = [
	automatedHeader(COMPACTED),
	automatedHeader(FAILED),
	"The context was compacted to keep this session affordable.",
	"Compacting the context failed, so it was left as it is.",
];

/** Whether a user message's text is one the harness sent to resume a run. */
export function isResumeText(text: string): boolean {
	const opening = text.trimStart();
	return OPENINGS.some((sentence) => opening.startsWith(sentence));
}

/**
 * Custom entry type written as a compaction is asked for, saying when
 * and whether the run that asked was going on, so whichever runtime
 * sees the compaction land can tell whether a run is owed.
 */
export const ASKED_ENTRY = "compaction-asked";

/** What a compaction's ask records. */
export interface CompactionAsk {
	/** When it was asked, in milliseconds since the epoch. */
	readonly at: number;
	/** Whether the turn that asked was going on to another. */
	readonly resume: boolean;
}

/**
 * Custom entry type written once a compaction's ask is answered: by the
 * runtime that asked, when its compaction lands or fails, or by the one
 * that sends the owed run in its place. An ask with one after it is
 * spent, so nothing sends its run twice, nor credits it to a later
 * compaction nobody asked for.
 */
export const SETTLED_ENTRY = "compaction-settled";

/** Who settled an ask: the runtime that asked, or one that came after. */
export type SettledBy = "asker" | "successor";

/** What a settled ask records. */
export interface CompactionSettled {
	/** When it was settled, in milliseconds since the epoch. */
	readonly at: number;
	/** Whether a run was resumed. */
	readonly resumed: boolean;
	/** Who settled it. */
	readonly by: SettledBy;
}

/**
 * How long a compaction may take to land and still be the one its ask
 * asked for. A summary takes a minute or two; a compaction landing
 * later than this is another, such as a /compact typed after the asked
 * one failed in a runtime a reload had replaced.
 */
export const ASK_LANDS_WITHIN_MS = 15 * 60_000;

/** How far ahead of the clock a compaction may be stamped and still count. */
const CLOCK_SKEW_MS = 60_000;

/**
 * How long after a compaction its owed run is still sent. A host comes
 * back within twenty minutes of a crash; a session opened days later
 * would start work nobody is waiting on.
 */
export const OWED_WITHIN_MS = 60 * 60_000;

/** An answer that ended on its own rather than being cut short. */
const FINISHED = new Set(["stop", "length"]);

function timeOf(entry: Record<string, unknown>): number {
	return typeof entry.timestamp === "string"
		? Date.parse(entry.timestamp)
		: Number.NaN;
}

/** The user or assistant message an entry holds, if it holds one. */
function conversed(entry: unknown): Record<string, unknown> | undefined {
	if (!isRecord(entry) || entry.type !== "message") return undefined;
	const { message } = entry;
	if (!isRecord(message)) return undefined;
	return message.role === "user" ||
		message.role === "assistant" ||
		message.role === "toolResult"
		? message
		: undefined;
}

/**
 * Whether an entry is an answer that ended on its own. One after an
 * ask means its run ended since, so the ask is spent: the person
 * carried on past an ask nothing settled, and a compaction of theirs
 * landing later owes nothing for it.
 */
function finishedAnswer(entry: unknown): boolean {
	const message = conversed(entry);
	return (
		message?.role === "assistant" && FINISHED.has(String(message.stopReason))
	);
}

/**
 * Whether the newest message in `entries` was written at or after `at`
 * and stops a run partway: a tool's result, a call for tools, or an
 * answer that was aborted or failed. That is a run the compaction cut,
 * which began after the turn that asked for it, so the ask's own word
 * on resuming doesn't cover it. On 19 November a job's result started
 * a run a second after a finished turn asked, the compaction's abort
 * cut it, and nothing resumed it. A prompt written after the ask with
 * no answer after it is a run cut before its first answer: pi refuses a
 * prompt while it compacts, so one in the log was begun.
 */
export function cutSince(entries: readonly unknown[], at: number): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = conversed(entry);
		if (message === undefined || !isRecord(entry)) continue;
		if (!(timeOf(entry) >= at)) return false;
		if (message.role !== "assistant") return true;
		return !FINISHED.has(String(message.stopReason));
	}
	return false;
}

/**
 * Whether the session's newest compaction stopped a run that nothing
 * has resumed: its ask said the run was going on, or a run begun after
 * the ask was cut, no message has followed it, and nobody settled the
 * ask. Only the compaction an ask asked for counts: the first after it,
 * landing within ASK_LANDS_WITHIN_MS. Read from the log,
 * since the runtime that asked may be gone: on 19 November 64 of 109
 * stalled compactions were followed by a reload before any message,
 * which dropped the resume the asking runtime would have sent.
 */
export function owesResume(
	branch: readonly unknown[],
	now: number,
	withinMs: number = OWED_WITHIN_MS,
): boolean {
	let compaction = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (isRecord(entry) && entry.type === "compaction") {
			compaction = i;
			break;
		}
		if (isCustom(entry, SETTLED_ENTRY)) return false;
		const message = conversed(entry);
		if (message !== undefined && message.role !== "toolResult") return false;
	}
	const landed = branch[compaction];
	if (!isRecord(landed)) return false;
	const landedAt = timeOf(landed);
	const age = now - landedAt;
	// A stamp from the future, by a skewed clock or a written log, is no
	// reason to start a run.
	if (!(age <= withinMs && age >= -CLOCK_SKEW_MS)) return false;
	const before = branch.slice(0, compaction);
	for (let i = before.length - 1; i >= 0; i--) {
		const entry = before[i];
		if (!isRecord(entry)) continue;
		if (entry.type === "compaction") return false;
		if (isCustom(entry, SETTLED_ENTRY)) return false;
		if (finishedAnswer(entry)) return false;
		if (!isCustom(entry, ASKED_ENTRY)) continue;
		const ask = entry.data;
		if (!isRecord(ask) || typeof ask.at !== "number") return false;
		if (!(landedAt - ask.at <= ASK_LANDS_WITHIN_MS)) return false;
		return ask.resume === true || cutSince(before, ask.at);
	}
	return false;
}

/**
 * The newest ask nothing has answered and no compaction has followed,
 * made within `withinMs` of `now` and with no answer since that ended
 * on its own: the ask of a compaction that failed or was cancelled
 * after the runtime that asked was gone, whose onError never ran here,
 * or of one cut short when pi stopped while it summarised. Malformed,
 * it is none.
 */
export function unsettledAsk(
	branch: readonly unknown[],
	now: number,
	withinMs: number = ASK_LANDS_WITHIN_MS,
): CompactionAsk | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!isRecord(entry)) continue;
		if (entry.type === "compaction") return undefined;
		if (isCustom(entry, SETTLED_ENTRY)) return undefined;
		if (finishedAnswer(entry)) return undefined;
		if (!isCustom(entry, ASKED_ENTRY)) continue;
		const ask = entry.data;
		if (!isRecord(ask) || typeof ask.at !== "number") return undefined;
		const age = now - ask.at;
		if (!(age <= withinMs && age >= -CLOCK_SKEW_MS)) return undefined;
		return { at: ask.at, resume: ask.resume === true };
	}
	return undefined;
}

/** Whether an entry is the custom entry of the given type. */
function isCustom(entry: unknown, customType: string): boolean {
	return (
		isRecord(entry) &&
		entry.type === "custom" &&
		entry.customType === customType
	);
}

/**
 * What a host says of itself in words, as systemd's status and the
 * journal show it: the step its start is in, how long each phase of a
 * resume, open or adopt took, what it holds once ready, and what it
 * parks as it stops.
 * run.ts says these at the moments they belong to, and backend.ts each
 * open's and adopt's time; the words change for the people reading them,
 * apart from when the host says them.
 */

import { drawsAsNothing } from "../../lib/internal/unseen.ts";
import { sessionAddress } from "../../lib/mesh/address.ts";
import type { StartPhase } from "./backend.ts";
import type { ServingHost, StartStep } from "./serve.ts";

const MS_PER_SECOND = 1000;

/** What a ready host holds, counted for its status. */
export interface ReadyCount {
	/** Conversations it runs, built and awake. */
	readonly loaded: number;
	/** Conversations it runs parked, building nothing until asked for. */
	readonly parked: number;
	/** Holds its start dropped, since their session files were gone. */
	readonly dropped: number;
	/** Holds it keeps but could not resume. */
	readonly unresumed: number;
	/** Conversations it holds that run in processes of their own. */
	readonly children?: number;
}

/**
 * What a serving host holds, counted for its ready status. A resume
 * that fails once it has registered leaves its conversation parked in
 * the host's list, so one of those counts as not resumed, never parked.
 */
export function readyCount(
	serving: Pick<
		ServingHost,
		| "held"
		| "unresumed"
		| "dropped"
		| "resting"
		| "stillUnresumed"
		| "inChildren"
	>,
): ReadyCount {
	const held = serving.held();
	const failed = new Set(serving.unresumed.map(({ sessionId }) => sessionId));
	const parkedFailed = held.filter(
		({ id, state }) => state === "parked" && failed.has(id),
	).length;
	const asleep =
		held.filter(({ state }) => state === "parked").length - parkedFailed;
	return {
		loaded: held.length - asleep - parkedFailed,
		parked: asleep + serving.resting(),
		dropped: serving.dropped.length,
		unresumed: serving.stillUnresumed(),
		children: serving.inChildren?.() ?? 0,
	};
}

/**
 * A ready host's status in words, as systemd's status and the journal
 * show it: how many it loaded, left parked and dropped, and any held but
 * not resumed.
 */
export function readyStatus(count: ReadyCount): string {
	const { loaded, parked, dropped, unresumed, children = 0 } = count;
	const apart = children > 0 ? `, ${children} in processes of their own` : "";
	const held = unresumed > 0 ? `, ${unresumed} held but not resumed` : "";
	return `ready: loaded ${loaded}, parked ${parked}${apart}, dropped ${dropped}${held}`;
}

/**
 * The holds a start dropped, named for the journal's ready line; nothing
 * when it dropped none. systemd's status keeps only the count, since a
 * start may drop dozens.
 */
export function droppedNames(dropped: readonly string[]): string {
	if (dropped.length === 0) return "";
	return ` (dropped, their session files gone: ${dropped.join(", ")})`;
}

/** A stopping host's status in words, while it parks what it runs. */
export function stoppingStatus(parking: number): string {
	return `stopping, parking ${conversations(parking)}`;
}

function conversations(count: number): string {
	if (count === 0) return "no conversations";
	return `${count} conversation${count === 1 ? "" : "s"}`;
}

/** When one phase of a resume, open or adopt ended. */
export interface PhaseEnd {
	readonly phase: StartPhase;
	readonly at: number;
}

/**
 * How long each phase of a start begun at `began` took, in words, and
 * what followed the last until `ended`; nothing when none was marked.
 */
export function phaseTimes(
	began: number,
	phases: readonly PhaseEnd[],
	ended: number,
): string {
	if (phases.length === 0) return "";
	let from = began;
	const parts = phases.map(({ phase, at }) => {
		const part = `${phase} ${((at - from) / MS_PER_SECOND).toFixed(1)} s`;
		from = at;
		return part;
	});
	parts.push(`rest ${((ended - from) / MS_PER_SECOND).toFixed(1)} s`);
	return ` (${parts.join(", ")})`;
}

/**
 * How long a conversation's open or adopt took, begun at `began` and
 * settled at `ended`, and each phase within it; one that failed before
 * pi named its conversation is said as a conversation not yet named,
 * with where it was asked to open or the file it was asked to adopt.
 */
export function startLine(
	sessionId: string | undefined,
	request:
		| { readonly op: "open"; readonly cwd: string }
		| { readonly op: "adopt"; readonly sessionFile: string },
	began: number,
	phases: readonly PhaseEnd[],
	ended: number,
): string {
	const who =
		sessionId === undefined
			? `A conversation not yet named, ${
					request.op === "open"
						? `opening in ${onOneLine(request.cwd)}`
						: `adopted from ${onOneLine(request.sessionFile)}`
				}`
			: `${onOneLine(sessionAddress(sessionId))} (${onOneLine(sessionId)})`;
	const took = ((ended - began) / MS_PER_SECOND).toFixed(1);
	return `${who}: its ${request.op} took ${took} s${phaseTimes(began, phases, ended)}`;
}

/** The escapes a journal reader knows by sight, for the characters that have one. */
const NAMED_ESCAPES: Readonly<Record<string, string>> = {
	"\\": "\\\\",
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
};

/** A control (C0, DEL, C1) or a line or paragraph separator, which end a line. */
const BREAKS_A_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** The widest code point a four-digit `\u` escape can name. */
const LAST_FOUR_DIGIT = 0xffff;

/** One code point as the escape a reader can type back. */
function escaped(point: number): string {
	return point > LAST_FOUR_DIGIT
		? `\\u{${point.toString(16)}}`
		: `\\u${point.toString(16).padStart(4, "0")}`;
}

/**
 * Words a requester chose, with every character that would break the
 * journal entry, forge another, move a terminal's cursor or read as other
 * than it is written as an escape: controls, line and paragraph
 * separators, and what draws as nothing, bidi marks and zero widths among
 * them. A backslash is doubled, so a path holding the text `\n` never
 * reads as one holding a newline; the words go straight into the line, so
 * nothing escapes them again.
 */
export function onOneLine(text: string): string {
	return escapedFor(text, true);
}

/**
 * `text` with what would break or disguise a journal line escaped, a
 * backslash doubled only when `doubling`: a reason may already hold
 * another reason's escapes, so doubling there would make a newline read
 * as the text `\n` once it is escaped twice (F24).
 */
function escapedFor(text: string, doubling: boolean): string {
	let said = "";
	for (const each of text) {
		const named = each === "\\" && !doubling ? each : NAMED_ESCAPES[each];
		if (named !== undefined) said += named;
		else if (BREAKS_A_LINE.test(each) || drawsAsNothing(each))
			said += escaped(each.codePointAt(0) ?? 0);
		else said += each;
	}
	return said;
}

/**
 * The first line of why something failed that says anything, to keep a
 * journal entry on one line, or nothing for a reason with no message;
 * the start's report says the rest, stack and all. Escaped as words are
 * but for a backslash, which stays single, so a reason wrapping a reason
 * this already escaped reads the same once escaped again.
 */
export function firstLine(reason: unknown): string {
	let text: unknown;
	try {
		text = reason instanceof Error ? reason.message : reason;
	} catch {
		// A message getter that throws says nothing; the report still has the reason.
		text = "";
	}
	if (typeof text !== "string") return "";
	return escapedFor(
		text
			.split(/\r?\n|\r/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "",
		false,
	);
}

/** A start step in words, as the journal and systemd's status show it. */
export function describeStep(step: StartStep): string {
	if (step.step === "roster")
		return `waiting on the last host, pid ${step.holder}, to let go of the roster`;
	return step.step === "engine"
		? "building the engine"
		: `resuming ${step.number} of ${step.of}: ${step.sessionId}`;
}

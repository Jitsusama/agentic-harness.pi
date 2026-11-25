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
 * with where it was asked to open or the file it was asked to adopt,
 * quoted.
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
						? `opening in ${quoted(request.cwd)}`
						: `adopted from ${quoted(request.sessionFile)}`
				}`
			: namedConversation(sessionId);
	const took = ((ended - began) / MS_PER_SECOND).toFixed(1);
	return `${who}: its ${request.op} took ${took} s${phaseTimes(began, phases, ended)}`;
}

/** An id as pi makes one, which can't pass for the line's own words. */
const PLAIN_ID = /^[\w.-]+$/u;

/**
 * A named conversation's address and id, as a journal line opens with
 * them. An adopted one's id comes from the requester's file, so it is
 * bounded as a path is, and it and the address made from its last eight
 * characters are each quoted unless plain: one holding `): ` or a quote
 * can't end the parentheses, or open the line, and pass its tail off as
 * the line's own words. A pi-made id and its address stay bare.
 */
export function namedConversation(sessionId: string): string {
	const { kept, cut } = bounded(sessionId);
	const address = sessionAddress(sessionId);
	return `${plainOrQuoted(address)} (${plainOrQuoted(kept)}${cut})`;
}

/** `text` bare when it is plain, else quoted and escaped as a path is. */
function plainOrQuoted(text: string): string {
	return PLAIN_ID.test(text) ? text : quoted(text);
}

/**
 * startLine for a start that failed, with the first line of why, quoted
 * and escaped as a path is, since the reason most often repeats the path
 * it couldn't open (F1 on #2107); or that it gave no reason.
 */
export function failedStartLine(
	sessionId: string | undefined,
	request:
		| { readonly op: "open"; readonly cwd: string }
		| { readonly op: "adopt"; readonly sessionFile: string },
	began: number,
	phases: readonly PhaseEnd[],
	ended: number,
	reason: unknown,
): string {
	const why = firstLineText(reason);
	return `${startLine(sessionId, request, began, phases, ended)}, failing${
		why ? `: ${quoted(why)}` : ", with no reason given"
	}`;
}

/**
 * The most characters of one requester's words a line keeps: a path
 * holds at most 4096 bytes, but a reason or an adopted id holds any
 * number, and journald splits a line past its LineMax into a second
 * entry whose start the requester would choose (F2 on #2107). Each kept
 * character escapes to at most ten, so a line stays far below 48 KiB.
 */
const MOST_KEPT = 500;

/** `text` cut to MOST_KEPT characters, and words saying how many went, if any did. */
function bounded(text: string): {
	readonly kept: string;
	readonly cut: string;
} {
	const points = Array.from(text);
	if (points.length <= MOST_KEPT) return { kept: text, cut: "" };
	return {
		kept: points.slice(0, MOST_KEPT).join(""),
		cut: `, cut after ${MOST_KEPT} of its ${points.length} characters`,
	};
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

/** A surrogate left unpaired, which UTF-8 can't hold, so the journal would show a replacement in its place (F27). */
const UNPAIRED = /\p{Cs}/u;

/** The widest code point a four-digit `\u` escape can name. */
const LAST_FOUR_DIGIT = 0xffff;

/** One code point as the escape a reader can type back. */
function escaped(point: number): string {
	return point > LAST_FOUR_DIGIT
		? `\\u{${point.toString(16)}}`
		: `\\u${point.toString(16).padStart(4, "0")}`;
}

/**
 * Words a requester chose, with these written as escapes: controls, line
 * and paragraph separators and unpaired surrogates, which break a journal
 * entry, forge another or move a terminal's cursor, and what drawsAsNothing
 * counts (format characters such as bidi marks and zero widths, and the
 * fillers and selectors it lists). Controls and separators would break a
 * journal entry, forge another or move a terminal's cursor; an unpaired
 * surrogate would show as a replacement, hiding what the requester sent.
 * A character that only looks like another, a Cyrillic letter for a
 * Latin one, passes as it is (F29), as does a paired astral character.
 * A backslash is doubled, so a path holding the text `\n` never reads as
 * one holding a newline.
 */
export function onOneLine(text: string): string {
	return escapedFor(text, true);
}

/**
 * Words a requester chose, escaped as onOneLine does and between double
 * quotes, a quote inside escaped, so a path can't pass its tail off as the
 * line's own words (F31). Backslashes are doubled before quotes are
 * escaped, so a backslash the words end on can't close the quote. Past
 * MOST_KEPT characters, the rest is left out and the line says so.
 */
function quoted(text: string): string {
	const { kept, cut } = bounded(text);
	return `"${onOneLine(kept).replaceAll('"', '\\"')}"${cut}`;
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
		else if (
			BREAKS_A_LINE.test(each) ||
			UNPAIRED.test(each) ||
			drawsAsNothing(each)
		)
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
	return escapedFor(firstLineText(reason), false);
}

/** The first line of why something failed that says anything, as it is, or nothing. */
function firstLineText(reason: unknown): string {
	let text: unknown;
	try {
		text = reason instanceof Error ? reason.message : reason;
	} catch {
		// A message getter that throws says nothing; the report still has the reason.
		text = "";
	}
	if (typeof text !== "string") return "";
	return (
		text
			.split(/\r?\n|\r/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
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

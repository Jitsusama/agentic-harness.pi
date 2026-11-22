/**
 * The prose gate's judged check: whether a text tells someone why
 * something happened as settled fact, with no test behind it.
 *
 * A cause told as fact is passed on as fact, by the peer that reads it
 * and then by whoever that peer tells, until someone who knows better
 * corrects it. A word list can't tell a diagnosis from a status line,
 * since "because" is in both, so a classifier judges, a part at a time:
 * a long digest's one causal sentence is lost when the digest is judged
 * whole. Every way of not judging (no classifier, an error, a slow
 * answer) finds nothing, so the check never stops a text it couldn't
 * read; a caller can be told why, so a check that judges nothing is
 * seen to.
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { Classify, FoundClassifier } from "../classifier/jev.ts";
import { settledWithin } from "../internal/settled.ts";

/**
 * How sure the classifier must be that a part states an untested cause
 * before it is refused. Over 54 mesh messages sampled on 21 November and
 * judged part by part, as this check does, 0.9 refused 1, a real untested
 * cause, and every status digest scored below 0.75. Over 106 replies to
 * the person judged whole, it refused 4, each real. Few wrong refusals
 * over catching every claim, since a gate that refuses honest status
 * lines gets turned off.
 */
export const UNTESTED_FLOOR = 0.9;

/**
 * How long one part may take to judge, and finding the classifier may
 * take. Jev answers in well under half a second; this is for the network
 * having gone. It is kept by a timer of its own, not only the signal
 * handed on, since a send waits on it. Finding the classifier and judging
 * the parts each have it in turn, so this holds a send at most twice
 * this long. A session's own lookup is held to it from its start too.
 */
export const JUDGE_MS = 2500;

/**
 * The most parts of one text judged, so a long text costs a bounded
 * wait. What a longer text holds past them is judged as one last part,
 * where a cause among the rest is less likely to be caught. Of the 54
 * mesh messages sampled on 21 November, split by paragraph, none ran
 * past 7 parts.
 */
const MOST_PARTS = 12;

/**
 * A part shorter than this says too little to state a cause. "Root
 * cause: disk full." is 22 characters, so the bar sits well below it.
 */
const SHORTEST_PART = 12;

/**
 * The most of one part sent to be judged, so a long text costs the
 * classifier's provider a bounded amount: the joined rest past
 * `MOST_PARTS`, or one paragraph holding a pasted log. About 400 words,
 * far past any paragraph in the 54 mesh messages sampled on 21
 * November. A longer part is judged by its first and last halves of
 * this, since a cause most often opens or closes what it explains; one
 * in the middle of such a part goes unjudged.
 */
const LONGEST_PART = 2000;

/** What stands between a long part's two ends where its middle is cut. */
const CUT = "\n...\n";

/**
 * Where a text breaks into parts: a blank line, or a line opening a
 * bullet or a numbered item.
 */
const PART_BREAK = /\n\s*\n|\n(?=\s*(?:[-*+\u2022]|\d+[.)]) )/;

/** The question's key in the classifier's answers. */
const QUESTION = "cause";

const UNTESTED = "untested_cause";

/** What the classifier is asked of each part. */
const QUESTIONS: ClassifierContext["questions"] = {
	[QUESTION]: {
		type: "choice",
		instructions:
			"An AI agent wrote this message for a person. Does it state why something happened (a cause or diagnosis of a problem or behaviour) as settled fact, without saying how that cause was tested?",
		criteria: {
			[UNTESTED]:
				"states a cause or diagnosis as settled fact and gives no test that established it",
			hypothesis:
				"offers a cause only as a hypothesis, guess or something still being tested",
			tested_cause:
				"states a cause and says how it was tested or cites a finding that tested it",
			no_cause:
				"reports status, actions, plans or observed results, or a cause directly read from an error or tool output, without diagnosing a hidden cause",
		},
	},
};

/**
 * A text's parts as they are judged: its paragraphs, and each item of a
 * list, of those long enough to state a cause. Past `MOST_PARTS`, the
 * rest is joined into the last, where a cause is judged among the rest.
 * Each runs to `LONGEST_PART` at most, a longer one kept by its ends.
 */
export function claimParts(text: string): string[] {
	return partsOf(text).parts;
}

/** A text's parts, as `claimParts`, and whether any ran past its bound. */
function partsOf(text: string): { parts: string[]; cut: boolean } {
	const parts = text
		.split(PART_BREAK)
		.map((part) => part.trim())
		.filter((part) => part.length >= SHORTEST_PART);
	const bounded =
		parts.length <= MOST_PARTS
			? parts
			: [
					...parts.slice(0, MOST_PARTS - 1),
					parts.slice(MOST_PARTS - 1).join("\n\n"),
				];
	return {
		parts: bounded.map(boundedPart),
		cut: bounded.some((part) => part.length > LONGEST_PART),
	};
}

/**
 * `part` held to `LONGEST_PART`: a longer one keeps its first and last
 * halves, with `CUT` between, each a character short where its cut would
 * fall between the two halves of one, so no half goes to the provider.
 */
function boundedPart(part: string): string {
	if (part.length <= LONGEST_PART) return part;
	const half = Math.floor((LONGEST_PART - CUT.length) / 2);
	const headEnd = isHighSurrogate(part.charCodeAt(half - 1)) ? half - 1 : half;
	const tailStart = part.length - half;
	const tailFrom = isLowSurrogate(part.charCodeAt(tailStart))
		? tailStart + 1
		: tailStart;
	return `${part.slice(0, headEnd)}${CUT}${part.slice(tailFrom)}`;
}

/** Whether `code` opens a character written in two halves. */
function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/** Whether `code` closes a character written in two halves. */
function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Told why a text, or some of its parts, went unjudged: `why` in words
 * that stay the same from text to text, so a caller can say each once,
 * and `detail`, when there is one, the first line of what went wrong.
 */
export type Unjudged = (why: string, detail?: string) => void;

/** The longest `detail` runs, so a page-long error costs a line. */
const DETAIL_LENGTH = 200;

/** The first line of `said`, at most `DETAIL_LENGTH` long. */
function detailOf(said: string): string {
	return (said.split("\n")[0] ?? "").slice(0, DETAIL_LENGTH);
}

/**
 * The parts of `text` that state an untested cause, judged by the
 * classifier `lookup` finds. Finding none in time, or one that can't
 * judge, finds nothing, and `unjudged` is told why; a classifier
 * switched off is meant, so nothing is told of it. `inFull` is told when
 * at least one part was judged and none went unjudged, so a caller knows
 * the classifier answered rather than that nothing was asked.
 */
export async function untestedCausesFound(
	text: string,
	lookup: Promise<FoundClassifier> | undefined,
	unjudged: Unjudged = () => undefined,
	inFull: () => void = () => undefined,
): Promise<string[]> {
	if (lookup === undefined) return [];
	const found = await settledWithin(lookup, JUDGE_MS);
	if (found === undefined) {
		unjudged(`finding the classifier took over ${JUDGE_MS} ms`);
		return [];
	}
	if (!found.ok) {
		if (!found.off) unjudged("no classifier", detailOf(found.reason));
		return [];
	}
	return untestedCauses(text, found.classify, unjudged, inFull);
}

/**
 * The parts of `text` the classifier is at least `UNTESTED_FLOOR` sure
 * state an untested cause, in the order they stand. A part it couldn't
 * judge is not among them, and `unjudged` is told why the first wasn't,
 * in words that stay the same from text to text, so a caller can say
 * each reason once; `inFull` is told when parts were judged and none
 * went unjudged.
 */
export async function untestedCauses(
	text: string,
	classify: Classify,
	unjudged: Unjudged = () => undefined,
	inFull: () => void = () => undefined,
): Promise<string[]> {
	const { parts, cut } = partsOf(text);
	if (cut) unjudged(`a part ran past ${LONGEST_PART} characters`);
	const judged = await Promise.all(
		parts.map((part) => untestedSureness(part, classify)),
	);
	const missed = judged.flatMap((one) => ("why" in one ? [one] : []));
	const [first] = missed;
	if (first !== undefined)
		unjudged(`a part went unjudged: ${first.why}`, first.detail);
	else if (parts.length > 0) inFull();
	return parts.filter((_, at) => {
		const one = judged[at];
		return one !== undefined && "sure" in one && one.sure >= UNTESTED_FLOOR;
	});
}

/**
 * How sure the classifier is that one part states an untested cause, or
 * why it couldn't say.
 */
async function untestedSureness(
	part: string,
	classify: Classify,
): Promise<
	{ readonly sure: number } | { readonly why: string; readonly detail?: string }
> {
	try {
		const result = await settledWithin(
			classify(
				{ state: { message: part }, questions: QUESTIONS },
				AbortSignal.timeout(JUDGE_MS),
			),
			JUDGE_MS,
		);
		// A request the signal ended may come back stopped as aborted rather
		// than thrown: the same slow answer either way.
		if (result === undefined || result.stopReason === "aborted")
			return { why: `no answer in ${JUDGE_MS} ms` };
		if (result.stopReason !== "stop") {
			const why = `the classifier stopped: ${result.stopReason}`;
			return result.errorMessage
				? { why, detail: detailOf(result.errorMessage) }
				: { why };
		}
		return { sure: untestedOf(result.answers[QUESTION]) };
	} catch (error) {
		// A part that couldn't be judged is let go, and its caller told: the
		// check refuses only what it read. A signal that ran out is the
		// same slow answer the timer reads, said the same way.
		if (
			error instanceof Error &&
			(error.name === "AbortError" || error.name === "TimeoutError")
		) {
			return { why: `no answer in ${JUDGE_MS} ms` };
		}
		return {
			why: "the classifier failed",
			detail: detailOf(error instanceof Error ? error.message : String(error)),
		};
	}
}

/** The probability an answer gives an untested cause, or 0. */
function untestedOf(answer: unknown): number {
	if (typeof answer !== "object" || answer === null) return 0;
	const probabilities: unknown = Reflect.get(answer, "probabilities");
	if (typeof probabilities !== "object" || probabilities === null) return 0;
	const untested: unknown = Reflect.get(probabilities, UNTESTED);
	return typeof untested === "number" ? untested : 0;
}

/** The longest a quoted part runs in a refusal. */
const QUOTED_LENGTH = 240;

/**
 * Why a text stating `found` is refused, and how to say it instead: as a
 * hypothesis, or citing the finding that tested it.
 */
export function untestedCauseReason(found: readonly string[]): string {
	const quoted = found
		.map((part) => {
			const line = part.replace(/\s+/g, " ");
			return `> ${line.length > QUOTED_LENGTH ? `${line.slice(0, QUOTED_LENGTH)}...` : line}`;
		})
		.join("\n");
	return [
		"This states why something happened as settled fact, with no test behind it:",
		quoted,
		'A cause told as fact is passed on as fact. Word it as a hypothesis ("on trial", "points at", "looks like X; testing that next"), or cite the finding that tested it: two independent methods, and an attempt to break it that it survived.',
	].join("\n");
}

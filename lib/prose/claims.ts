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
 * read.
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { Classify, FoundClassifier } from "../classifier/jev.ts";

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
 * this long.
 */
const JUDGE_MS = 2500;

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
 * rest is joined into the last, so every part is read, though one in
 * that last part is judged among the rest.
 */
export function claimParts(text: string): string[] {
	const parts = text
		.split(PART_BREAK)
		.map((part) => part.trim())
		.filter((part) => part.length >= SHORTEST_PART);
	if (parts.length <= MOST_PARTS) return parts;
	return [
		...parts.slice(0, MOST_PARTS - 1),
		parts.slice(MOST_PARTS - 1).join("\n\n"),
	];
}

/**
 * The parts of `text` that state an untested cause, judged by the
 * classifier `lookup` finds. Finding none in time, or one that can't
 * judge, finds nothing.
 */
export async function untestedCausesFound(
	text: string,
	lookup: Promise<FoundClassifier> | undefined,
): Promise<string[]> {
	const found = lookup ? await settledWithin(lookup, JUDGE_MS) : undefined;
	return found?.ok ? untestedCauses(text, found.classify) : [];
}

/**
 * The parts of `text` the classifier is at least `UNTESTED_FLOOR` sure
 * state an untested cause, in the order they stand. A part it couldn't
 * judge is not among them.
 */
export async function untestedCauses(
	text: string,
	classify: Classify,
): Promise<string[]> {
	const judged = await Promise.all(
		claimParts(text).map(async (part) =>
			(await untestedSureness(part, classify)) >= UNTESTED_FLOOR
				? part
				: undefined,
		),
	);
	return judged.filter((part) => part !== undefined);
}

/** How sure the classifier is that one part states an untested cause. */
async function untestedSureness(
	part: string,
	classify: Classify,
): Promise<number> {
	try {
		const result = await settledWithin(
			classify(
				{ state: { message: part }, questions: QUESTIONS },
				AbortSignal.timeout(JUDGE_MS),
			),
			JUDGE_MS,
		);
		if (result?.stopReason !== "stop") return 0;
		return untestedOf(result.answers[QUESTION]);
	} catch {
		// A part that couldn't be judged is let go: the check refuses only
		// what it read.
		return 0;
	}
}

/** What `work` settles to within `ms`, or nothing once that has passed. */
async function settledWithin<T>(
	work: Promise<T>,
	ms: number,
): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(resolve, ms, undefined);
	});
	try {
		return await Promise.race([work, late]);
	} finally {
		clearTimeout(timer);
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

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
import type { Classify } from "../classifier/jev.ts";

/**
 * How sure the classifier must be that a part states an untested cause
 * before it is refused. Over 160 replies and mesh texts sampled from two
 * days of sessions on 21 November, 0.9 refused 5, each a real untested
 * cause on reading; below it sat status digests and causes read straight
 * from an error. Few wrong refusals over catching every claim, since a
 * gate that refuses honest status lines gets turned off.
 */
export const UNTESTED_FLOOR = 0.9;

/**
 * How long one part may take to judge. Jev answers in well under half a
 * second; this is for the network having gone.
 */
const JUDGE_MS = 2500;

/** The most parts of one text judged, so a long text costs a bounded wait. */
const MOST_PARTS = 12;

/** A part shorter than this says too little to state a cause. */
const SHORTEST_PART = 25;

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
 * A text's parts as they are judged: its paragraphs, and each bullet of
 * a list, of those long enough to state a cause, at most `MOST_PARTS`.
 */
export function claimParts(text: string): string[] {
	return text
		.split(/\n\s*\n|\n(?=\s*[-*] )/)
		.map((part) => part.trim())
		.filter((part) => part.length >= SHORTEST_PART)
		.slice(0, MOST_PARTS);
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
		const result = await classify(
			{ state: { message: part }, questions: QUESTIONS },
			AbortSignal.timeout(JUDGE_MS),
		);
		if (result.stopReason !== "stop") return 0;
		return untestedOf(result.answers[QUESTION]);
	} catch {
		// A part that couldn't be judged is let go: the check refuses only
		// what it read.
		return 0;
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

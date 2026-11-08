/**
 * A proposal's description, taken as its four sections rather than as
 * one string.
 *
 * A body passed whole can have the wrong headings, the wrong order or
 * a stack note where the TL;DR should be, and each of those is a
 * refusal and a rewrite. Taken as fields, the tool writes the skeleton
 * itself, so the only thing the author can get wrong is the words, and
 * the contract for each section sits in that field's description at
 * the moment it is written. This holds whatever the guard policy says,
 * because a parameter the call does not have is not a mode.
 */

import { Type } from "@sinclair/typebox";
import {
	composePrBody,
	PR_FIELDS,
	type PrFields,
	readPrFields,
	reviseFields,
} from "../../../lib/core/sections/compose.ts";
import {
	PR_SECTIONS,
	PR_SHAPE,
} from "../../../lib/core/sections/sanctioned.ts";
import { count } from "../../../lib/ui/count.ts";

/** The four section fields, as a call may carry any of them. */
export type SectionFields = Partial<PrFields>;

/** What the call's sections come to: a body, a body still to read, or a refusal. */
export type SectionsOutcome =
	| { readonly kind: "none" }
	| { readonly kind: "body"; readonly body: string }
	| { readonly kind: "revise"; readonly fields: SectionFields }
	| { readonly kind: "refuse"; readonly reason: string };

/** How each field reads to a person, for naming the ones missing. */
const LABEL: Record<(typeof PR_FIELDS)[number], string> = {
	tldr: "tldr",
	problem: "problem",
	solution: "solution",
	validation: "validation",
};

const [TLDR, PROBLEM, SOLUTION, VALIDATION] = PR_SECTIONS.map(
	(section) => PR_SHAPE.sections[section] ?? {},
);

/**
 * A word count to aim for, three quarters of the ceiling, to the five
 * below.
 *
 * A ceiling stated alone is written to, and a count made by feel lands
 * either side of it. Of 219 TL;DRs proposed on 21 and 22 October, 127
 * ran 35 to 39 words and 61 ran 40 or more, against a ceiling of 40;
 * 33 were refused, 19 of them for one or two words. Each refusal costs
 * a whole turn. Aiming lower keeps the ceiling where it is and gives
 * the guess room to be wrong.
 */
function aim(ceiling: number): number {
	return Math.floor((ceiling * 3) / 4 / 5) * 5;
}

/** "Aim for about A words; at most C", and the code spans it may hold. */
function limits(rules: { words?: number; codeSpans?: number }): string {
	const { words, codeSpans } = rules;
	if (words === undefined) return "";
	const spans = codeSpans ? ` and ${codeSpans} code spans` : "";
	return `Aim for about ${aim(words)} words; at most ${words}${spans}.`;
}

/** The ceiling every sentence in every section is held to. */
const SENTENCE = PR_SHAPE.sentenceWords
	? ` In every section no sentence may pass ${PR_SHAPE.sentenceWords} words (aim under ${aim(PR_SHAPE.sentenceWords)}).`
	: "";

/** Where a large change learns it may go deeper, said once on the first field. */
const DEPTH = PR_SHAPE.depth
	? ` From ${PR_SHAPE.depth.fromLines.toLocaleString("en-CA")} changed lines it may go deeper under #### parts (github-pr-format, A Large Change).`
	: "";

/**
 * The per-section contract, said where the author writes each one.
 *
 * Listed in the order the schema presents them: problem, solution,
 * validation, then the TL;DR. The TL;DR is written last because it
 * summarizes the rest, and rendered first because it is what a reader
 * sees in the time they have.
 *
 * Every number comes from the shape the gate enforces, so the contract
 * an author reads cannot fall behind the one that refuses them. The
 * sentence ceiling and the Solution's code spans went unsaid while the
 * numbers were typed out here, and of the reasons refusals gave on 21
 * and 22 October, 30 were a long sentence and 7 the Solution's spans.
 *
 * Each is said in as few words as keep its rules: every session reads
 * the declaration on every turn, about 60,000 turns a day, and on 8
 * November these four were 3,500 of review_offer's 8,000 characters
 * (QCXZEB). The why behind each rule is the github-pr-format skill's.
 */
export const SECTION_DESCRIPTIONS = {
	problem: `For propose and edit. Limits are ceilings, not targets.${SENTENCE} Why the change exists, for a reader who knows the product but not this change and won't open the diff: what was wrong, who it hurt, how we know (a count, an incident, an error seen). If they'd assume the wrong cause: 'it looks like X; it is actually Y, because Z'. Prose only; no tour, never the fix. ${limits(PROBLEM)}${DEPTH}`,
	solution: `For propose and edit: behaviour and its mechanism. Open with prose: when what happens, what follows, why that fixes it. Each behaviour names where it doesn't hold (exception, fallback, opt-in) in the same sentence. A real choice reads 'X rather than Y, because Z'; invent none. Keep, as typed, what a reader must act on: what breaks, is refused or removed, config keys and values, commands, CI jobs, dependency ranges, migrations. No fact beyond the diff, commits or what ran. Bullets only for parallel behaviours, at most ${SOLUTION.bullets}, each opening with what sets it apart, never Docs:, Tests: or Files:. ${limits(SOLUTION)}`,
	validation: `For propose and edit. Checked: what ran and what it showed, per claim, so it can be rerun (command, test, count); never a bare 'tests pass'. Not covered: where the checks stop, as fact, not guess. Watch: a signal after merge that would show it wrong, only if the change makes one. No hedges (should, likely) or assurances (robust). ${limits(VALIDATION)} At most ${VALIDATION.bullets} bullets.`,
	tldr: `For propose and edit: the eight-second version, written last; most readers read only this. ${limits(TLDR)} At most ${count(TLDR.sentences ?? 2, "sentence")}. The first opens with what changed (never 'This PR'): what differs, for whom. The second: the key decision, or how far the checks reach. Keep the Solution's qualifiers (drop the claim, never the qualifier) and numbers' exact meaning; a count or named set, never a bare all, every or most. No code, file names, links, bullets or bold. A 'Part of #482' paragraph may follow, uncounted.`,
} as const;

/** The schema entries for the four fields, in the order they should be written. */
export function sectionParameters() {
	return {
		problem: Type.Optional(
			Type.String({ description: SECTION_DESCRIPTIONS.problem }),
		),
		solution: Type.Optional(
			Type.String({ description: SECTION_DESCRIPTIONS.solution }),
		),
		validation: Type.Optional(
			Type.String({ description: SECTION_DESCRIPTIONS.validation }),
		),
		tldr: Type.Optional(
			Type.String({ description: SECTION_DESCRIPTIONS.tldr }),
		),
	};
}

/**
 * The schema for one change's sections in a stack. All four are
 * required, as they are for a single proposal, and each points at the
 * contract on propose's field of the same name rather than saying it
 * again. Both sit in one declaration the model reads whole, and said
 * twice the contract cost about 3,500 characters on every turn of every
 * session, for an action used a handful of times.
 */
export function stackSections() {
	// The sections parameter says they keep propose's contract, so each
	// field saying it again only costs every request the words.
	return {
		problem: Type.String(),
		solution: Type.String(),
		validation: Type.String(),
		tldr: Type.String(),
	};
}

/** The section fields a call carries, and nothing else. */
function given(params: SectionFields): SectionFields {
	const out: Partial<Record<(typeof PR_FIELDS)[number], string>> = {};
	for (const field of PR_FIELDS) {
		const value = params[field];
		if (value !== undefined) out[field] = value;
	}
	return out;
}

/**
 * What a call's sections and body come to.
 *
 * Proposing takes all four sections or none: a change opened with half a
 * description is one somebody has to come back to. An edit may name some
 * and keep the rest, which needs the change's current body, so it comes
 * back as something to revise once that is read. Sections and a body
 * together are refused, since one of them would be thrown away.
 */
export function sectionsOf(
	action: string,
	params: SectionFields & { body?: string },
): SectionsOutcome {
	const fields = given(params);
	const named = Object.keys(fields).length;
	if (named === 0) return { kind: "none" };
	if (params.body !== undefined) {
		return {
			kind: "refuse",
			reason:
				"Give the description as the four sections or as a body, not both. The sections are the better way: the tool writes the headings, the order and where the issue line goes.",
		};
	}
	if (named === PR_FIELDS.length) {
		return { kind: "body", body: composePrBody(fields as PrFields) };
	}
	if (action === "edit") return { kind: "revise", fields };
	const missing = PR_FIELDS.filter((f) => fields[f] === undefined);
	return {
		kind: "refuse",
		reason: `A change needs all four sections. This is missing ${missing.map((f) => LABEL[f]).join(", ")}.`,
	};
}

/**
 * The current body with some sections replaced, or a refusal when the
 * current body is not in the four-section shape and so has nothing to
 * keep.
 */
export function revised(
	current: string,
	fields: SectionFields,
): { body: string } | { refusal: string } {
	const { fields: existing } = readPrFields(current);
	const kept = PR_FIELDS.filter(
		(f) => existing[f] !== undefined || fields[f] !== undefined,
	);
	if (kept.length < PR_FIELDS.length) {
		const missing = PR_FIELDS.filter(
			(f) => existing[f] === undefined && fields[f] === undefined,
		);
		return {
			refusal: `This change's description does not have ${missing.map((f) => LABEL[f]).join(", ")} to keep, so an edit of some sections cannot finish it. Give all four sections to replace the description.`,
		};
	}
	return { body: reviseFields(current, fields) };
}

/** Whether a context block is a stack note, which a new note replaces. */
const isStackNote = (block: string): boolean => /^>\s*\[!NOTE\]/.test(block);

/**
 * A body with a stack note in it.
 *
 * A four-section body takes the note straight after its TL;DR's text,
 * replacing any note already there, so the first thing a notification
 * or a link preview shows is still the TL;DR. A body in any other shape
 * has nowhere better, and keeps the note on top as it always has.
 */
export function withNote(body: string, note: string): string {
	const { fields, context } = readPrFields(body);
	if (fields.tldr === undefined) return [note, "", body].join("\n");
	return reviseFields(body, {}, [
		...context.filter((block) => !isStackNote(block)),
		note,
	]);
}

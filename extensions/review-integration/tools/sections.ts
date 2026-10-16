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

import {
	composePrBody,
	PR_FIELDS,
	type PrFields,
	readPrFields,
	reviseFields,
} from "@jitsusama/agentic-harness.core/sections";
import { Type } from "@sinclair/typebox";

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

/**
 * The per-section contract, said where the author writes each one.
 *
 * Listed in the order the schema presents them: problem, solution,
 * validation, then the TL;DR. The TL;DR is written last because it
 * summarizes the rest, and rendered first because it is what a reader
 * sees in the time they have.
 */
export const SECTION_DESCRIPTIONS = {
	problem:
		"For propose and edit: the limits on every section are ceilings, not targets, and most changes need well under half. Why this change exists, for a teammate who knows the product, has not seen the change and will not open the diff. Start from what they already know, then say what was wrong, who it hurt and the evidence (a count, an incident, an error a person saw). Prose only, no bullets, at most 120 words, at most 3 code spans. Never the fix.",
	solution:
		"For propose and edit: what the change does about the problem, as behaviour rather than files. Open by answering the problem. Name the one decision that mattered and the alternative it beat. Say what a reader has to do differently, if anything (new config, a breaking change). At most 200 words; bullets only for three or more parallel behaviours, at most 5, and never a list of artifacts such as Docs:, Tests: or Dependency:.",
	validation:
		"For propose and edit: why a reader should believe it works. Each claim about behaviour with its proof, then what is not proven and what to watch after merging. Numbers that mean something to a person, not raw test counts. A limit is something not done or not tested, never a guess. This is where commands and code belong. At most 100 words, at most 5 bullets.",
	tldr: "For propose and edit: the eight-second pitch, written last and shown first. What is different once this merges and why it matters, in at most 40 words and two sentences, adding to the title rather than repeating it. No code, file names, links or bullets. A tracking-issue line such as 'Part of #482' may follow as its own paragraph and does not count.",
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
 * required, as they are for a single proposal, and each says the same
 * contract, since a model writing the third change of a stack reads this
 * description and not the one on propose's fields.
 */
export function stackSections() {
	const bare = (text: string) => text.replace(/^For propose and edit: /, "");
	return {
		problem: Type.String({ description: bare(SECTION_DESCRIPTIONS.problem) }),
		solution: Type.String({ description: bare(SECTION_DESCRIPTIONS.solution) }),
		validation: Type.String({
			description: bare(SECTION_DESCRIPTIONS.validation),
		}),
		tldr: Type.String({ description: bare(SECTION_DESCRIPTIONS.tldr) }),
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
		reason: `A proposal needs all four sections. This is missing ${missing.map((f) => LABEL[f]).join(", ")}.`,
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

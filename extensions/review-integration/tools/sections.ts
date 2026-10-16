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
		"For propose and edit: the limits on every section are ceilings, not targets, and most changes need well under half. The reader knows the product, has not seen this change, was not in the session and will not open the diff. Why the change exists: what was wrong compared with what they know, who it hurt, and how we know (a count, an incident, an error a person saw). No tour of the subsystem. If they would assume the wrong cause, say 'it looks like X; it is actually Y, because Z'. Prose only, at most 120 words and 3 code spans. Never the fix.",
	solution:
		"For propose and edit: what the change does, as behaviour and the mechanism behind it. Open with a sentence of prose saying when what happens, what now follows, and why that fixes the problem. For each behaviour claimed, name the path where it does not hold (an exception, a fallback, an opt-in) in the same sentence. State a real choice as a contrast: X rather than Y, because Z, with what it gives up only when the change shows a cost; never invent either. Always keep what a reader must act on, named as they will type it: something breaking, refused or removed (by its name), a config key and every key it accepts, a command, a CI job or trigger, a dependency and its range, a migration. Add no fact the diff, the commits or what you ran do not show. Bullets only for parallel behaviours, at most 5, each opening with what tells it apart, never a list of artifacts such as Docs:, Tests: or Files:. At most 200 words.",
	validation:
		"For propose and edit: Checked: what ran and what it showed, for each claim, named so the reader could rerun it (the command, the test directory or test, the count); coverage is not a result, and never a bare 'tests pass'. Not covered: where those checks stop, as a fact about them ('the tests use a stand-in for the server, so a real crash is not exercised'), never a guess about what was not run. Watch: an observable signal after merge that would show it is wrong, only if the change makes one visible; never a guessed cause. No hedges (should work, likely) or assurances (thoroughly tested, robust). At most 100 words and 5 bullets.",
	tldr: "For propose and edit: the eight-second version, written last and shown first; most readers read only this. At most 40 words in two sentences. The first opens with the thing that changed (never 'This PR') and says what is different and for whom; the second carries the key decision, or how far the checks reach when that narrows the first. Every claim carries the Solution's qualifiers; if one will not fit, drop the claim, not the qualifier. A number keeps its exact meaning. Give the count or name the set, never a bare all, every or most. No code, file names, links, bullets or bold. A tracking-issue line such as 'Part of #482' may follow as its own paragraph and does not count.",
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

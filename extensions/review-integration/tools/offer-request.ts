/**
 * What a `review_offer` call passes, and its words made ready before
 * anything reads them: a title put in Title Case, the four sections
 * told apart from a body, and a refused proposal's draft filled back in.
 *
 * Apart from `offer.ts` because these change with the conventions a
 * call's words are held to, not with what any action does.
 */

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { sessionCwd, sessionKeyOf } from "../../../lib/core/session/index.ts";
import {
	detectTitleViolations,
	toTitleCase,
} from "../../../lib/core/title/index.ts";
import { draftKey, filledFromRefused } from "./resubmit.ts";
import type { SectionFields } from "./sections.ts";

/** What the tool was asked to do. */
export interface OfferParams {
	action:
		| "propose"
		| "propose-stack"
		| "edit"
		| "ready"
		| "unready"
		| "close"
		| "reopen"
		| "merge"
		| "reviewers"
		| "rerun"
		| "retarget-stack";
	change?: string;
	which?: string;
	repo?: string;
	base?: string;
	head?: string;
	heads?: string[];
	title?: string;
	tldr?: string;
	problem?: string;
	solution?: string;
	validation?: string;
	body?: string;
	bodies?: string[];
	sections?: Required<SectionFields>[];
	draft?: boolean;
	comment?: string;
	method?: string;
	expectedHead?: string;
	person?: string;
	reviewers?: string[];
	labels?: string[];
	labelMode?: "add" | "set";
	unlabels?: string[];
	assignees?: string[];
	unassignees?: string[];
	clear?: string[];
}

/**
 * A title that reads as a sentence, put in Title Case rather than
 * refused: 34 sessions since 18 October were refused for it, each once,
 * and the fix is mechanical. The gate shows the title as it will be
 * sent. A title already in Title Case, lowercase proper nouns and all,
 * is left as written.
 */
export function inTitleCase(title: string): string {
	const sentence = detectTitleViolations(title).some(
		(violation) => violation.issue === "sentence-case",
	);
	return sentence ? toTitleCase(title) : title;
}

/** The four sections a call gives, when it gives every one of them. */
export function sectionsGiven(
	params: SectionFields,
): Required<SectionFields> | undefined {
	const { tldr, problem, solution, validation } = params;
	return tldr !== undefined &&
		problem !== undefined &&
		solution !== undefined &&
		validation !== undefined
		? { tldr, problem, solution, validation }
		: undefined;
}

/**
 * A proposal resubmitted after a refusal, with the title and sections
 * it left out taken from the draft under `key` (see {@link draftOf}).
 * A call giving a body, or every section, is its own whole draft.
 */
export function resubmitted<
	T extends SectionFields & {
		title?: string;
		body?: string;
	},
>(params: T, key: string): T {
	if (params.body !== undefined || sectionsGiven(params)) return params;
	const filled = filledFromRefused(key, params.title, params);
	return filled
		? {
				...params,
				...filled.sections,
				...(filled.title ? { title: filled.title } : {}),
			}
		: params;
}

/**
 * The key of a proposal's refused draft: this conversation's, of the
 * checkout the call works in and the branch it named.
 */
export function draftOf(
	ctx: ExtensionToolContext,
	params: { repo?: string; head?: string },
): string {
	return draftKey(
		sessionKeyOf(ctx),
		params.repo ?? sessionCwd(ctx),
		params.head,
	);
}

/**
 * Saying so when a refused description comes back unchanged.
 *
 * A description that breaks the PR format is refused with every point
 * to fix, and a tool call cannot loop, so nothing is lost by refusing
 * it again. But the logs show agents sending the same words back, 15
 * times in 257 refusals, and getting the same list with nothing to say
 * they had changed nothing. A refusal that reads like the first one
 * reads like a fresh problem. Saying it is the same text, refused a
 * moment ago, tells the agent the list is still waiting to be read.
 */

import { createHash } from "node:crypto";

/** How many refused descriptions are remembered, newest kept. */
const REMEMBERED = 32;

/** When each refused description was refused, by its digest. */
const refused = new Map<string, number>();

/**
 * The complaint as it should be said: with a note in front when this
 * exact title and body were refused before in this session.
 */
export function sayRefusal(
	complaint: string,
	title: string | undefined,
	body: string | undefined,
	now: number = Date.now(),
): string {
	const key = createHash("sha1")
		.update(`${title ?? ""}\0${body ?? ""}`)
		.digest("hex");
	const before = refused.get(key);
	refused.delete(key);
	refused.set(key, now);
	if (refused.size > REMEMBERED) {
		const oldest = refused.keys().next().value;
		if (oldest !== undefined) refused.delete(oldest);
	}
	if (before === undefined) return complaint;
	return `${unchanged(now - before)}\n\n${complaint}`;
}

/** Forget every refusal; for tests. */
export function forgetRefusals(): void {
	refused.clear();
	drafts.clear();
}

/**
 * How long a refused proposal's sections are kept for a resubmit to
 * fill from. Long enough to rewrite one section, short enough that a
 * later proposal of the same branch starts fresh.
 */
const DRAFT_KEPT_MS = 30 * 60_000;

/** The four sections, as a proposal gives them. */
export interface DraftSections {
	readonly tldr?: string;
	readonly problem?: string;
	readonly solution?: string;
	readonly validation?: string;
}

/** A refused proposal, kept so a resubmit need carry only what it changes. */
interface Draft {
	readonly title?: string;
	readonly sections: Required<DraftSections>;
	readonly at: number;
}

/** The latest refused proposal of each repo and branch, by that pair. */
const drafts = new Map<string, Draft>();

/** Which proposal a draft is of: the repo and branch as the call named them. */
export function draftKey(repo?: string, head?: string): string {
	return `${repo ?? ""}\0${head ?? ""}`;
}

/**
 * Keep a refused proposal's title and sections. The logs showed 487
 * refusals of the PR format in 44 sessions, each followed by the whole
 * description written out again to change one sentence.
 */
export function keepRefusedDraft(
	key: string,
	title: string | undefined,
	sections: Required<DraftSections>,
	now: number = Date.now(),
): void {
	drafts.delete(key);
	drafts.set(key, { ...(title ? { title } : {}), sections, at: now });
	if (drafts.size > REMEMBERED) {
		const oldest = drafts.keys().next().value;
		if (oldest !== undefined) drafts.delete(oldest);
	}
}

/**
 * A resubmit's title and sections with what it left out taken from the
 * proposal refused under the same key, or nothing when there is no such
 * draft, it has expired, or the resubmit gave every section anyway.
 */
export function filledFromRefused(
	key: string,
	title: string | undefined,
	sections: DraftSections,
	now: number = Date.now(),
): { title?: string; sections: Required<DraftSections> } | undefined {
	const draft = drafts.get(key);
	if (!draft || now - draft.at > DRAFT_KEPT_MS) return undefined;
	const filled = {
		tldr: sections.tldr ?? draft.sections.tldr,
		problem: sections.problem ?? draft.sections.problem,
		solution: sections.solution ?? draft.sections.solution,
		validation: sections.validation ?? draft.sections.validation,
	};
	const kept = title ?? draft.title;
	return { ...(kept ? { title: kept } : {}), sections: filled };
}

/** What a refusal of a proposal given as sections adds, saying how to resubmit. */
export const RESUBMIT_ONLY_CHANGES =
	"To send it again, give only the title or sections you change: the rest is kept from this draft for 30 minutes.";

function unchanged(elapsedMs: number): string {
	const minutes = Math.round(elapsedMs / 60_000);
	const when =
		minutes < 1
			? "less than a minute ago"
			: minutes === 1
				? "a minute ago"
				: `${minutes} minutes ago`;
	return `This is word for word the description refused ${when}, so every point below still stands. Change the text where each point says before sending it again.`;
}

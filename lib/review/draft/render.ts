/**
 * A review with nowhere to post, written down.
 *
 * Reviewing a stack of branches nobody has proposed is a real
 * activity, and the fact that no server will accept the result
 * does not make the result worthless. So a draft can always
 * become a document: the summary, the remarks grouped by the
 * file they are about, and the verdict recorded the way git
 * records a verdict, as a trailer.
 *
 * The trailer vocabulary is borrowed rather than invented.
 * `Reviewed-by` is what a reviewer stamps on work they accept
 * and `Nacked-by` is the long-standing way to record an
 * objection; a review that takes no position gets no trailer,
 * because that is what taking no position means.
 */

import type { Anchor } from "../anchor.js";
import type { Actor, ReviewTarget } from "../change.js";
import type { DraftState, FindingItem } from "./state.js";

/** Who is reviewing, and anything else the document needs. */
export interface RenderOptions {
	/** The reviewer, for the verdict trailer. */
	author?: Actor;
}

/** A review, written out. */
export interface ReviewDocument {
	title: string;
	markdown: string;
	/** Trailers recording the verdict, ready to append. */
	trailers: string[];
}

/** How to name what was reviewed. */
function describeTarget(target: ReviewTarget): string {
	if (target.kind === "proposal") {
		return `${target.change.repo.key} ${target.change.id}`;
	}
	if (target.kind === "range") {
		return `${target.base}..${target.head}`;
	}
	return target.refs.join(", ");
}

/** Where in a file a remark points. */
function describeLocation(anchor: Anchor): string {
	if (anchor.subject === "file") return "the file as a whole";
	const lines =
		anchor.startLine && anchor.startLine !== anchor.line
			? `${anchor.startLine}-${anchor.line}`
			: `${anchor.line}`;
	return `line ${lines} (${anchor.blob})`;
}

/** Findings in file order, each file keeping its own order. */
function groupByFile(findings: FindingItem[]): Map<string, FindingItem[]> {
	const grouped = new Map<string, FindingItem[]>();
	for (const finding of findings) {
		const existing = grouped.get(finding.anchor.path);
		if (existing) existing.push(finding);
		else grouped.set(finding.anchor.path, [finding]);
	}
	return grouped;
}

/** How the reviewer is named in a trailer. */
function nameFor(author: Actor): string {
	return author.name ? `${author.name} <${author.id}>` : author.id;
}

/**
 * The trailers recording a verdict. Approval and objection
 * both have long-standing spellings; taking no position has
 * no trailer, which is the point of taking no position.
 */
function verdictTrailers(
	state: DraftState,
	author: Actor | undefined,
): string[] {
	if (!author || !state.verdict) return [];
	if (state.verdict === "approve") return [`Reviewed-by: ${nameFor(author)}`];
	if (state.verdict === "request-changes") {
		return [`Nacked-by: ${nameFor(author)}`];
	}
	return [];
}

/** Render a draft as a document. */
export function renderDraft(
	state: DraftState,
	options?: RenderOptions,
): ReviewDocument {
	const subject = describeTarget(state.target);
	const title = `Review of ${subject}`;
	const trailers = verdictTrailers(state, options?.author);
	const sections: string[] = [`# ${title}`];

	if (state.summary) sections.push(state.summary);

	const findings = state.items.filter(
		(item): item is FindingItem => item.kind === "finding",
	);
	for (const [path, forFile] of groupByFile(findings)) {
		const remarks = forFile.map(
			(finding) => `- ${describeLocation(finding.anchor)}\n  ${finding.body}`,
		);
		sections.push(`## ${path}`, remarks.join("\n"));
	}

	const replies = state.items.filter((item) => item.kind === "reply");
	if (replies.length > 0) {
		const lines = replies.map((item) =>
			item.kind === "reply"
				? `- in reply to ${item.thread.id}\n  ${item.body}`
				: "",
		);
		sections.push("## Replies", lines.join("\n"));
	}

	if (findings.length === 0 && replies.length === 0 && !state.summary) {
		sections.push("No remarks.");
	}

	if (trailers.length > 0) sections.push(trailers.join("\n"));

	return { title, markdown: `${sections.join("\n\n")}\n`, trailers };
}

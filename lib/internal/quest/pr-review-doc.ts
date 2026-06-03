/**
 * Render a PR review round as markdown and append it to a
 * per-sidequest research document.
 *
 * pr-workflow drives council, judge and (optionally)
 * critique rounds against a loaded PR. The judge's
 * consolidated findings are the durable artifact each
 * round produces. We persist them as a research document
 * under the sidequest the PR is attached to so the user
 * has a greppable trail of every round, before any of it
 * gets posted to GitHub.
 *
 * The document is single-purpose: one per sidequest, with
 * a section per round appended over time. Round 1
 * scaffolds the file (mints the id, writes frontmatter and
 * H1); rounds 2 and beyond append a new section to the
 * existing body. The existing frontmatter is preserved as
 * is except for `updated`, which always advances to the
 * current date.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocumentFrontMatter } from "../../quest/types.js";
import { nowYmd } from "./dates.js";
import {
	parseDocumentFrontMatter,
	serializeDocumentFrontMatter,
} from "./frontmatter.js";
import { mintId } from "./id.js";
import { atomicWriteFile } from "./io.js";
import { escapeMarkdownStructure } from "./sanitize.js";

/** Subject tag stored on the doc's frontmatter so findExistingDoc can match it without parsing the body. */
const PR_REVIEW_SUBJECT = "pr-review";

/**
 * Cross-reviewer agreement metadata for one finding.
 * Mirrors the pr-workflow shape but defined here so this
 * library doesn't reach into an extension.
 */
export interface ReviewDocAgreement {
	readonly raisedBy: readonly string[];
	readonly sourceFindingIds?: readonly number[];
}

/** Critique position vocabulary. */
export type ReviewDocCritiquePosition =
	| "agree"
	| "disagree"
	| "qualify"
	| "amplify";

/** Judge self-signal mirrored from pr-workflow. */
export interface ReviewDocJudgeSelfSignal {
	readonly confidence: "low" | "medium" | "high";
	readonly rationale: string;
}

/** Finding shape required to render a round. */
export interface ReviewDocFinding {
	id: number;
	label: string;
	severity?: string;
	subject: string;
	discussion: string;
	location:
		| { kind: "line"; file: string; start: number; end: number; side: string }
		| { kind: "file"; file: string }
		| { kind: "global" };
	agreement?: ReviewDocAgreement;
}

/** Per-finding critique entries from the round-3 critique pass. */
export interface ReviewDocCritique {
	findingId: number;
	reviewerId: string;
	position: ReviewDocCritiquePosition;
	rationale: string;
}

/** Input for `renderPrReviewRound`. */
export interface RenderRoundInput {
	/** Round number, 1-based. */
	roundNumber: number;
	/** Date the round ran (YYYY-MM-DD). */
	date: string;
	/** Reviewers that ran the council round (ids). */
	councilReviewerIds: string[];
	/** Total raw findings across reviewers before judge consolidation. */
	rawFindingsCount: number;
	/** The judge's consolidated findings for this round. */
	judgeFindings: ReviewDocFinding[];
	/** Judge self-signal, when surfaced. */
	judgeSelfSignal?: ReviewDocJudgeSelfSignal | null;
	/** Optional critique entries grouped per finding. */
	critiques?: ReviewDocCritique[];
}

function renderLocation(loc: ReviewDocFinding["location"]): string {
	switch (loc.kind) {
		case "line":
			return `${loc.file}:${loc.start}-${loc.end} (${loc.side} side)`;
		case "file":
			return loc.file;
		case "global":
			return "PR-wide";
	}
}

function renderAgreement(a?: ReviewDocAgreement): string {
	if (!a) return "";
	const raised = a.raisedBy.length;
	if (raised === 0) return "";
	return `Raised by: ${a.raisedBy.join(", ")}.`;
}

function renderCritiqueLines(
	findingId: number,
	critiques?: ReviewDocCritique[],
): string[] {
	if (!critiques) return [];
	const mine = critiques.filter((c) => c.findingId === findingId);
	if (mine.length === 0) return [];
	const lines: string[] = ["", "Critique:"];
	for (const c of mine) {
		lines.push(`- ${c.reviewerId} (${c.position}): ${c.rationale}`);
	}
	return lines;
}

function renderOneFinding(
	finding: ReviewDocFinding,
	critiques?: ReviewDocCritique[],
): string[] {
	const severity = finding.severity ? ` (${finding.severity})` : "";
	// Discussion prose is reviewer-authored. Escape leading
	// `#` and `##` so a finding cannot pose as a new round
	// or finding heading inside the doc the agent reads.
	const escapedDiscussion = escapeMarkdownStructure(finding.discussion.trim());
	const escapedSubject = finding.subject.replace(/[\r\n]+/g, " ");
	const lines: string[] = [
		`#### Finding ${finding.id} \u2014 ${finding.label}: ${escapedSubject}${severity}`,
		"",
		`Location: ${renderLocation(finding.location)}.`,
		"",
		escapedDiscussion,
	];
	const agreement = renderAgreement(finding.agreement);
	if (agreement) {
		lines.push("");
		lines.push(agreement);
	}
	lines.push(...renderCritiqueLines(finding.id, critiques));
	lines.push("");
	return lines;
}

/**
 * Render one review round as a markdown block. Does not
 * include frontmatter or the document H1; the caller
 * stitches those in (`appendPrReviewRound` does it).
 */
export function renderPrReviewRound(input: RenderRoundInput): string {
	const lines: string[] = [];
	lines.push(`## Round ${input.roundNumber} \u2014 ${input.date}`);
	lines.push("");
	lines.push(
		`Council reviewers: ${input.councilReviewerIds.join(", ") || "(none recorded)"}.`,
	);
	lines.push(
		`Raw findings: ${input.rawFindingsCount}. Judge consolidated to ${input.judgeFindings.length}.`,
	);
	if (input.judgeSelfSignal) {
		lines.push("");
		lines.push(
			`Judge self-signal: ${input.judgeSelfSignal.confidence} confidence. ${input.judgeSelfSignal.rationale}`,
		);
	}
	lines.push("");
	if (input.judgeFindings.length === 0) {
		lines.push("_No consolidated findings this round._");
		lines.push("");
		return lines.join("\n");
	}
	for (const finding of input.judgeFindings) {
		lines.push(...renderOneFinding(finding, input.critiques));
	}
	return lines.join("\n");
}

/** Result of `appendPrReviewRound`. */
export interface AppendRoundResult {
	/** Absolute path to the research doc on disk. */
	path: string;
	/** Research-doc id (RSCH-...). */
	docId: string;
	/** Round number that just landed. */
	roundNumber: number;
	/** True when this call scaffolded the doc for the first time. */
	isNew: boolean;
}

/** Input for `appendPrReviewRound`. */
export interface AppendRoundInput
	extends Omit<RenderRoundInput, "roundNumber"> {
	/** Sidequest directory under the questsRoot. */
	sidequestDir: string;
	/** Sidequest id (used to wire the doc's `quest` field). */
	sidequestId: string;
	/** PR identifier for the document title (e.g. owner/repo#nnn). */
	prSlug: string;
	/** Clock injected for tests. */
	now?: () => Date;
}

/**
 * Find the PR-review research doc for a sidequest by
 * matching the frontmatter marker (`kind: research,
 * subject: pr-review`) rather than parsing the body's H1.
 * The H1 is reviewer-prose-adjacent and could be shadowed
 * by a hostile finding subject; the frontmatter is ours.
 */
function findExistingDoc(researchDir: string):
	| {
			path: string;
			parsed: NonNullable<ReturnType<typeof parseDocumentFrontMatter>>;
	  }
	| undefined {
	if (!existsSync(researchDir)) return undefined;
	const entries = readdirSync(researchDir);
	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		const full = join(researchDir, name);
		const text = readFileSync(full, "utf8");
		const parsed = parseDocumentFrontMatter(text);
		if (!parsed) continue;
		if (parsed.frontMatter.kind !== "research") continue;
		if (parsed.frontMatter.subject === PR_REVIEW_SUBJECT) {
			return { path: full, parsed };
		}
	}
	return undefined;
}

/**
 * Append a review round to the sidequest's research doc.
 * Scaffolds the document on first call (round 1); appends
 * a new section on every subsequent call.
 */
export function appendPrReviewRound(
	input: AppendRoundInput,
): AppendRoundResult {
	const researchDir = join(input.sidequestDir, "research");
	const existing = findExistingDoc(researchDir);
	const date = input.date || nowYmd(input.now);

	if (existing) {
		// Round number is anchored to frontmatter so a
		// reviewer finding whose discussion starts with
		// `## Round 99` cannot inflate the count.
		const priorRounds = existing.parsed.frontMatter.rounds ?? 0;
		const roundNumber = priorRounds + 1;
		const section = renderPrReviewRound({
			...input,
			roundNumber,
			date,
		});
		const fm: DocumentFrontMatter = {
			...existing.parsed.frontMatter,
			updated: date,
			rounds: roundNumber,
			subject: PR_REVIEW_SUBJECT,
		};
		const newText = `${serializeDocumentFrontMatter(fm)}\n\n${existing.parsed.body.replace(/\s*$/, "")}\n\n${section}\n`;
		atomicWriteFile(existing.path, newText);
		return {
			path: existing.path,
			docId: existing.parsed.frontMatter.id,
			roundNumber,
			isNew: false,
		};
	}

	mkdirSync(researchDir, { recursive: true });
	const docId = mintId("RSCH");
	const fm: DocumentFrontMatter = {
		id: docId,
		kind: "research",
		quest: input.sidequestId,
		stage: "build",
		updated: date,
		rounds: 1,
		subject: PR_REVIEW_SUBJECT,
	};
	const fmBlock = serializeDocumentFrontMatter(fm);
	const section = renderPrReviewRound({ ...input, roundNumber: 1, date });
	const body = [
		fmBlock,
		"",
		`# PR Review: ${input.prSlug}`,
		"",
		section,
		"",
	].join("\n");
	// Match the quest extension's convention: `${id}.md`,
	// no slug. The H1 and the frontmatter `kind: research`
	// say what the document is; the title in the body
	// names the PR.
	const path = join(researchDir, `${docId}.md`);
	atomicWriteFile(path, body);
	return { path, docId, roundNumber: 1, isNew: true };
}

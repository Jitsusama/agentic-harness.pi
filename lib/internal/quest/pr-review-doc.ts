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
import {
	parseDocumentFrontMatter,
	serializeDocumentFrontMatter,
} from "./frontmatter.js";
import { mintId } from "./id.js";
import { atomicWriteFile } from "./io.js";

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
	const lines: string[] = [
		`#### Finding ${finding.id} \u2014 ${finding.label}: ${finding.subject}${severity}`,
		"",
		`Location: ${renderLocation(finding.location)}.`,
		"",
		finding.discussion.trim(),
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

function nowYmd(now: () => Date): string {
	const d = now();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function findExistingDoc(researchDir: string): string | undefined {
	if (!existsSync(researchDir)) return undefined;
	const entries = readdirSync(researchDir);
	// Single-doc-per-sidequest convention: the first
	// markdown file whose body starts with the PR review
	// H1 wins. We don't pin the filename so we can read
	// docs back regardless of how they were named.
	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		const text = readFileSync(join(researchDir, name), "utf8");
		if (/^#\s+PR Review:/m.test(text)) return join(researchDir, name);
	}
	return undefined;
}

function countRounds(body: string): number {
	const matches = body.match(/^##\s+Round\s+\d+/gm);
	return matches ? matches.length : 0;
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
	const now = input.now ?? (() => new Date());
	const date = input.date || nowYmd(now);

	if (existing) {
		const text = readFileSync(existing, "utf8");
		const parsed = parseDocumentFrontMatter(text);
		if (!parsed) {
			throw new Error(
				`Existing review doc at ${existing} has no readable frontmatter.`,
			);
		}
		const roundNumber = countRounds(parsed.body) + 1;
		const section = renderPrReviewRound({
			...input,
			roundNumber,
			date,
		});
		// Bump `updated`, keep everything else.
		const fm: DocumentFrontMatter = {
			...parsed.frontMatter,
			updated: date,
		};
		const newText = `${serializeDocumentFrontMatter(fm)}\n\n${parsed.body.replace(/\s*$/, "")}\n\n${section}\n`;
		atomicWriteFile(existing, newText);
		return {
			path: existing,
			docId: parsed.frontMatter.id,
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

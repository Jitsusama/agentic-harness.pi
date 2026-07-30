/**
 * What a participant is told.
 *
 * The prose here is deliberately about how to review rather than
 * about JSON. The output contract belongs in a skill loaded into the
 * subagent, because a contract repeated in two places drifts, and
 * the one in the prompt is the copy nobody updates.
 *
 * What the prompt owes the reviewer is the material: the change, its
 * body, the diff, and where an anchor is allowed to land. That last
 * one is why this module exists rather than the prompt being a
 * template string at the call site.
 */

import type { Proposal } from "../change.js";
import type { DiffModel } from "../diff.js";
import { filePath, hunkHeader } from "../diff.js";
import { anchorableRanges, describeRanges } from "./anchorable.js";

/** What a round needs to say to whoever it asks. */
export interface PromptInput {
	proposal: Proposal;
	diff: DiffModel;
	/** Extra direction for this round only. */
	intent?: string;
}

/** What a judge needs, on top of the change itself. */
export interface JudgePromptInput extends PromptInput {
	/** What the reviewers said, rendered for the judge to weigh. */
	findings: string;
}

/** The prompt a discovery reviewer answers. */
export function councilPrompt(input: PromptInput): string {
	return [
		"You are one of several reviewers reading the same change independently. Your pass is for discovery: find what is worth saying, and say why you believe it. Another pass will consolidate, and a third will push back, so a finding you are unsure of is still worth raising as long as the uncertainty comes with the evidence that would settle it.",
		"Read the change below, then use your tools on the tree to check what the diff cannot tell you: who calls this, what the tests around it assume, whether the library really behaves the way the code expects. A finding grounded in something you went and read is worth ten that restate the diff.",
		"Cover correctness, security, performance, interface design, readability, test quality and naming. Say where each finding points and what the consequence is. Do not describe what the diff already shows.",
		anchorGuidance(input.diff),
		intentSection(input.intent),
		changeSection(input.proposal),
		diffSection(input.diff),
		"Answer in the JSON your output contract skill describes, and call the verify tool before you finish. A pass with nothing to say answers with an empty findings list rather than prose.",
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** The prompt a consolidating judge answers. */
export function judgePrompt(input: JudgePromptInput): string {
	return [
		"Several reviewers read this change independently and raised the findings below. Your pass is consolidation: decide what is real, merge what is the same observation in different words, and drop what does not survive contact with the code.",
		"Agreement between reviewers who could not see each other's work is evidence, so record it: when you merge several into one, name the reviewer ids that raised it in raisedBy. That is how a reader later knows a finding was found twice rather than once.",
		"Be willing to drop a finding entirely. A reviewer that misread the code, or flagged a risk the surrounding code already handles, produced a finding that would waste the author's time. Check the ones that matter against the tree before you keep them.",
		anchorGuidance(input.diff),
		intentSection(input.intent),
		changeSection(input.proposal),
		"## What the reviewers said",
		input.findings.trim() === ""
			? "(nothing was raised, so there is nothing to consolidate)"
			: input.findings.trim(),
		diffSection(input.diff),
		"Answer in the JSON your output contract skill describes, and call the verify tool before you finish.",
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** Where anchors may land, so a finding does not degrade for nothing. */
function anchorGuidance(diff: DiffModel): string {
	return [
		"## Where a finding may anchor",
		"A line finding has to name a line that appears in the diff below. One that points elsewhere still counts, but it degrades to a remark on the change as a whole and loses the line it meant, so use a file-scoped or change-scoped finding when what you have to say is not about one line.",
		describeRanges(anchorableRanges(diff)),
	].join("\n\n");
}

/** The round's own direction, when it was given one. */
function intentSection(intent: string | undefined): string {
	const trimmed = intent?.trim() ?? "";
	return trimmed === "" ? "" : `## For this pass in particular\n\n${trimmed}`;
}

/** The change, as its author described it. */
function changeSection(proposal: Proposal): string {
	const parts = [`## The change\n\n${proposal.title || "(no title)"}`];
	const body = proposal.body?.trim() ?? "";
	if (body !== "") parts.push(`### As its author described it\n\n${body}`);
	return parts.join("\n\n");
}

/** The diff itself, hunk by hunk. */
function diffSection(diff: DiffModel): string {
	if (diff.files.length === 0) return "## The diff\n\n(no files changed)";
	const files = diff.files.map((file) => {
		const hunks = file.hunks.map((hunk) => {
			const lines = hunk.lines.map((line) => {
				const marker =
					line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
				return `${marker}${line.text}`;
			});
			return [hunkHeader(hunk), ...lines].join("\n");
		});
		return [`### ${filePath(file)}`, "```", ...hunks, "```"].join("\n");
	});
	return ["## The diff", ...files].join("\n\n");
}

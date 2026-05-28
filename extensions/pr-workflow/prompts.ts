/**
 * Reviewer prompt builder for council round 1.
 *
 * Pure. Takes a target (PR title, description, parsed diff)
 * and returns a single prompt string the runtime sends to a
 * reviewer model. The prompt teaches the reviewer the
 * Finding shape, demands JSON output and forbids prose-only
 * responses.
 *
 * Higher rounds (judge, critique) get their own prompt
 * builders in follow-up commits. This module covers round 1.
 */

import type { DiffFile, DiffLine } from "../../lib/internal/github/diff.js";
import { reviewerOperatingRules } from "./prompt-operating-rules.js";
import {
	reviewDiscoveryStandard,
	reviewQualityStandard,
} from "./review-quality-standard.js";
import {
	type ReviewThreadPromptContext,
	renderReviewThreadPromptContext,
} from "./thread-context.js";

/** Inputs the reviewer needs to do its job. */
export interface ReviewerPromptInput {
	readonly prTitle: string;
	readonly prDescription: string;
	readonly files: DiffFile[];
	readonly threadContext?: ReviewThreadPromptContext;
	readonly promptAddendum?: string;
}

/**
 * Build the round-1 reviewer prompt for `input`.
 *
 * The output is intentionally one long string the caller
 * sends as the user message. We don't separate system /
 * user roles here so the same prompt works whether the
 * runtime uses single-turn or multi-turn completion.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
	const sections: string[] = [];

	sections.push(
		"You are a senior code reviewer participating in a multi-model code review " +
			"council. Your round is the noisy, high-recall discovery pass. Read " +
			"the pull request below, inspect the worktree with your tools and report " +
			"findings the judge and critic should consider. Other reviewers will " +
			"independently review the same PR; later phases will merge, falsify and " +
			"filter the candidate list before anything posts.",
	);

	sections.push(
		"Default to depth over restraint. Trace callers and callees, check nearby " +
			"tests, verify framework or library semantics and use scoped searches under " +
			"changed directories before you decide a risk is real. It's acceptable to " +
			"surface uncertain material risks, but the uncertainty must come with the " +
			"specific evidence you found and the condition that would prove or disprove " +
			"the finding.",
	);

	sections.push(
		"Be specific. Each finding must name an exact location (file, line range if " +
			"applicable) and explain the concern in concrete terms. Line findings must " +
			"anchor to changed PR lines you verified from source, not stale line numbers " +
			"or unchanged context. Cite the code you saw and the user, backend or " +
			"operational impact. Don't repeat what the diff already shows.",
	);

	sections.push(
		"Cover the spectrum: correctness, security, performance, API design, " +
			"readability, test quality, naming. Use Conventional Comments labels: " +
			"praise, nitpick, suggestion, issue, todo, question, thought, chore or note. " +
			"Optional decorations are free-form short tags " +
			'(e.g. "non-blocking", "if-minor"). Optional severity is "critical", ' +
			'"medium" or "minor". Optional confidence is a number 0.0 to 1.0.',
	);

	sections.push(reviewQualityStandard());
	sections.push(reviewDiscoveryStandard());
	sections.push(renderReviewThreadPromptContext(input.threadContext));
	pushPromptAddendum(sections, input.promptAddendum);
	sections.push(reviewerOperatingRules());

	sections.push("## PR title");
	sections.push(input.prTitle || "(no title)");

	if (input.prDescription.trim()) {
		sections.push("## PR description");
		sections.push(input.prDescription.trim());
	}

	if (input.files.length > 0) {
		sections.push("## Anchorable line ranges");
		sections.push(
			"Line-kind findings must anchor to lines listed below. The " +
				"verify pass rejects line locations outside these ranges; " +
				"pick `file`- or `global`-kind for issues that span the file " +
				"or scope as a whole.",
		);
		sections.push(renderAnchorableLineRanges(input.files));
	}

	sections.push("## Diff");
	if (input.files.length === 0) {
		sections.push("(no files changed)");
	} else {
		for (const file of input.files) {
			sections.push(renderFile(file));
		}
	}

	sections.push("## Output format");
	sections.push(
		"Follow the `pr-workflow-council-output` skill for your output contract: " +
			"the JSON shape, location kinds, threadRelation vocabulary and the " +
			"`verify_output` self-check protocol. The skill is loaded into this " +
			"subagent. Do not invent a different shape; rely on `verify_output`'s " +
			"feedback to converge on a valid payload before ending your run.",
	);

	return sections.join("\n\n");
}

function pushPromptAddendum(
	sections: string[],
	addendum: string | undefined,
): void {
	const trimmed = addendum?.trim();
	if (trimmed === undefined || trimmed.length === 0) return;
	sections.push(["## Provider review context", trimmed].join("\n\n"));
}

/**
 * Compact, per-file summary of which lines in the diff
 * a line-kind finding can anchor to. Reviewers see this
 * BEFORE the full diff so the anchorable surface is
 * explicit.
 *
 * Each file gets one line: `path: 47-89, 245-260`,
 * collapsing contiguous hunks into a single range. Files
 * with no hunks (renames, mode changes) are omitted.
 */
function renderAnchorableLineRanges(files: readonly DiffFile[]): string {
	const lines: string[] = [];
	for (const file of files) {
		const ranges = anchorableRangesFor(file);
		if (ranges.length === 0) continue;
		lines.push(`${file.path}: ${ranges.join(", ")}`);
	}
	return lines.length === 0 ? "(no anchorable lines)" : lines.join("\n");
}

/**
 * Collapse a file's hunks into a list of
 * `start-end` strings on the new-side line numbers.
 * Adjacent hunks that touch are merged so the output
 * stays short.
 */
function anchorableRangesFor(file: DiffFile): string[] {
	const rawRanges: Array<{ start: number; end: number }> = [];
	for (const hunk of file.hunks) {
		const lineNumbers: number[] = [];
		for (const line of hunk.lines) {
			const lineNumber = line.newLineNumber ?? line.oldLineNumber;
			if (lineNumber !== null) lineNumbers.push(lineNumber);
		}
		if (lineNumbers.length === 0) continue;
		rawRanges.push({
			start: Math.min(...lineNumbers),
			end: Math.max(...lineNumbers),
		});
	}
	rawRanges.sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of rawRanges) {
		const tail = merged[merged.length - 1];
		if (tail && range.start <= tail.end + 1) {
			tail.end = Math.max(tail.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged.map((r) =>
		r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`,
	);
}

function renderFile(file: DiffFile): string {
	const header = renderHeader(file);
	if (file.hunks.length === 0) {
		return `${header}\n(no hunks)`;
	}
	const hunks = file.hunks
		.map((h) => `${h.header}\n${h.lines.map(renderLine).join("\n")}`)
		.join("\n");
	return `${header}\n${hunks}`;
}

function renderHeader(file: DiffFile): string {
	return `### ${file.path} (${file.status})`;
}

function renderLine(line: DiffLine): string {
	switch (line.type) {
		case "added":
			return `+${line.content}`;
		case "removed":
			return `-${line.content}`;
		default:
			return ` ${line.content}`;
	}
}

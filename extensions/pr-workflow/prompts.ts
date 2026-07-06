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
import { isGeneratedPath } from "./generated-files.js";
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

	// Omit generated and vendored files from the inline diff
	// so the reviewer spends its attention and prompt budget
	// on hand-written code. Guard against blanking the diff:
	// if every changed file is generated, show them all
	// rather than hand the reviewer nothing.
	const reviewable = input.files.filter((f) => !isGeneratedPath(f.path));
	const omitted = input.files.filter((f) => isGeneratedPath(f.path));
	const files = reviewable.length > 0 ? reviewable : input.files;
	const omittedForNote = reviewable.length > 0 ? omitted : [];

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

	if (omittedForNote.length > 0) {
		sections.push("## Omitted generated files");
		sections.push(
			"These changed files are generated or vendored and are left out " +
				"of the diff below. Read them with your tools if a finding " +
				"depends on them, but do not review them for style: " +
				omittedForNote.map((f) => f.path).join(", "),
		);
	}

	if (files.length > 0) {
		sections.push("## Anchorable line ranges");
		sections.push(
			"Line-kind findings should anchor to the lines listed below. " +
				"Findings whose `start`/`end` falls outside the listed ranges " +
				"are kept but post as body comments instead of inline; the " +
				"parent process emits a warning so the user can fix the range. " +
				"Use `file`- or `global`-kind for issues that span the file or " +
				"scope as a whole.",
		);
		sections.push(renderAnchorableLineRanges(files));
	}

	sections.push("## Diff");
	if (files.length === 0) {
		sections.push("(no files changed)");
	} else {
		for (const file of files) {
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
 * The summary lists new-side ranges by default (most
 * findings anchor to added or modified code on the
 * RIGHT). When a file only changes on the old side (pure
 * deletion), the line is annotated `side=old`. Files
 * with no hunks (renames, mode changes) are omitted.
 */
function renderAnchorableLineRanges(files: readonly DiffFile[]): string {
	const lines: string[] = [];
	for (const file of files) {
		const newRanges = anchorableRangesFor(file, "new");
		const oldRanges = anchorableRangesFor(file, "old");
		const parts: string[] = [];
		if (newRanges.length > 0) {
			parts.push(`new ${newRanges.join(", ")}`);
		}
		if (oldRanges.length > 0) {
			parts.push(`old ${oldRanges.join(", ")}`);
		}
		if (parts.length === 0) continue;
		lines.push(`${file.path}: ${parts.join(" | ")}`);
	}
	return lines.length === 0 ? "(no anchorable lines)" : lines.join("\n");
}

/**
 * Collapse a file's hunks into a list of `start-end`
 * strings on the requested diff side. Adjacent hunks that
 * touch are merged so the output stays short.
 */
function anchorableRangesFor(file: DiffFile, side: "old" | "new"): string[] {
	const rawRanges: Array<{ start: number; end: number }> = [];
	for (const hunk of file.hunks) {
		const lineNumbers: number[] = [];
		for (const line of hunk.lines) {
			const lineNumber =
				side === "old" ? line.oldLineNumber : line.newLineNumber;
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

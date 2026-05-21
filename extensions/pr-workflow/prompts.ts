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
import { CouncilFindingsOutput } from "./schemas.js";

/** Inputs the reviewer needs to do its job. */
export interface ReviewerPromptInput {
	readonly prTitle: string;
	readonly prDescription: string;
	readonly files: DiffFile[];
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
			"council. Your job is to read the pull request below and report findings: " +
			"things worth flagging to the author. Other reviewers will independently " +
			"review the same PR; a judge will consolidate everyone's findings later.",
	);

	sections.push(
		"Be specific. Each finding must name an exact location (file, line range if " +
			"applicable) and explain the concern in concrete terms. Cite the code you " +
			"saw. Don't repeat what the diff already shows.",
	);

	sections.push(
		"Cover the spectrum: correctness, security, performance, API design, " +
			"readability, test quality, naming. Use Conventional Comments labels: " +
			"praise, nitpick, suggestion, issue, todo, question, thought, chore, note, " +
			"typo, polish, quibble. Optional decorations are free-form short tags " +
			'(e.g. "non-blocking", "if-minor"). Optional severity is "critical", ' +
			'"medium" or "minor". Optional confidence is a number 0.0 to 1.0.',
	);

	sections.push(reviewerOperatingRules());

	sections.push("## PR title");
	sections.push(input.prTitle || "(no title)");

	if (input.prDescription.trim()) {
		sections.push("## PR description");
		sections.push(input.prDescription.trim());
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
		"Reply with a fenced JSON block. No prose outside the block. The JSON object " +
			'must have a "findings" array. Each finding must include "location", ' +
			'"label", "subject" and "discussion"; "decorations", "severity" and ' +
			'"confidence" are optional. If you have nothing to flag, return ' +
			'{"findings": []}.',
	);
	sections.push(
		'Location kinds: "line" (file + start/end + side: "old"|"new"|"both"), ' +
			'"file" (file only), or "global" (PR-level).',
	);

	sections.push("## JSON Schema");
	sections.push(
		"Your output must match this JSON Schema exactly. The same schema is used " +
			"by the `verify_output` tool you'll call below and by the parent parser, " +
			"so anything that passes the verifier will be accepted.",
	);
	sections.push(
		["```json", JSON.stringify(CouncilFindingsOutput, null, 2), "```"].join(
			"\n",
		),
	);

	sections.push("## Self-verify before ending");
	sections.push(
		"Before you finish your run, call the `verify_output` tool with " +
			'stage: "council" and `output` set to the object you intend to emit. ' +
			"The tool returns `ok: true` with the parsed finding count, or `ok: false` " +
			"with a list of {path, message} errors. If errors are reported, fix the " +
			"offending fields and call `verify_output` again. Only emit your final " +
			"fenced JSON block (and end the run) once the verifier returns `ok: true`. " +
			"If the verifier keeps reporting the same error after three attempts, " +
			"emit your best attempt and the parent will surface the warnings.",
	);

	return sections.join("\n\n");
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

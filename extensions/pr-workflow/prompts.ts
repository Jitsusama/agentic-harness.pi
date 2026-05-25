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
import { CouncilFindingsOutput } from "./schemas.js";
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
	sections.push(
		"If a finding relates to an existing review thread, set optional " +
			'`threadRelation`: use kind "duplicates-existing" only when the new ' +
			"finding should not be posted because [T#] already covers it; use " +
			'"supports-existing", "disputes-existing" or "amplifies-existing" ' +
			"when you have fresh evidence that should substantiate, disprove or " +
			"accentuate that thread. Include `threadIndex` with the numeric T index " +
			"and a short `rationale`. Omit `threadRelation`, or use kind `new`, " +
			"when no existing thread is relevant.",
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
			"with a list of {path, message, hint} errors. If errors are reported, fix the " +
			"offending fields and call `verify_output` again. Only emit your final " +
			"fenced JSON block (and end the run) once the verifier returns `ok: true`. " +
			"If the verifier keeps reporting the same error after three attempts, " +
			"emit your best attempt and the parent will surface the warnings.",
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

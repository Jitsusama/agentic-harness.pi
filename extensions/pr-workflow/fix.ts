/**
 * Fix subagent dispatcher.
 *
 * The differentiator between a review tool and a tool
 * that moves code: when the user verdicts a finding as
 * `fix`, the agent dispatches a coding pi subagent
 * against the council's worktree to apply real edits.
 *
 * One subagent per finding. The subagent gets:
 *
 *   - the finding's location, subject and discussion
 *     (the prompt carries everything it needs)
 *   - optional user instructions
 *   - the worktree path as cwd
 *   - file-mutating tools (edit, write) in `--tools`
 *
 * It returns a structured JSON object summarising what
 * was changed. The actual file edits happen via pi's
 * own edit/write tools inside the subagent process.
 *
 * The subprocess boundary is `RunPi` — the same one
 * council reviewers use. Production code wraps
 * `node:child_process.spawn`; tests substitute a stub.
 *
 * What's intentionally NOT in this module:
 *   - committing the changes (commit-guardian handles
 *     that the moment the agent runs `git commit`)
 *   - pushing (user-driven)
 *   - re-running tests (a follow-up; design 16's
 *     `checks` list)
 */

import type { Finding, FindingLocation } from "./findings.js";
import {
	extractUsageFromPiStream,
	type ReviewerUsage,
	type RunPi,
} from "./reviewer.js";

/** Structured output from one fix subagent. */
export interface FixOutput {
	readonly findingId: number;
	readonly summary: string;
	readonly modifiedFiles: string[];
}

/** Inputs for `buildFixPrompt`. */
export interface BuildFixPromptOptions {
	readonly finding: Finding;
	readonly worktreePath: string;
	readonly prTitle?: string;
	readonly userInstructions?: string;
}

/** Inputs for `runFix`. */
export interface RunFixOptions {
	readonly runPi: RunPi;
	readonly model?: string;
	readonly tools: readonly string[];
	readonly finding: Finding;
	readonly worktreePath: string;
	readonly prTitle?: string;
	readonly userInstructions?: string;
	readonly signal?: AbortSignal;
}

/** Result of one fix attempt. */
export type RunFixResult =
	| {
			ok: true;
			output: FixOutput;
			stderr: string;
			usage?: ReviewerUsage;
	  }
	| { ok: false; error: string; stderr?: string; usage?: ReviewerUsage };

/** Result of `parseFixOutput`. */
export type ParseFixResult =
	| { ok: true; value: FixOutput }
	| { ok: false; error: string };

/**
 * Build the prompt the fix subagent sees. The prompt
 * carries the finding's full context (location, subject,
 * discussion), pins the JSON schema for the response and
 * instructs the subagent to apply edits via real tool
 * calls rather than just describe them.
 */
export function buildFixPrompt(options: BuildFixPromptOptions): string {
	const { finding, worktreePath, prTitle, userInstructions } = options;
	const where = renderLocation(finding.location);
	const lines: string[] = [
		"You are a coding subagent applying a single PR review finding.",
		"",
		"Your job is to apply the change directly to the working tree using your edit/write tools.",
		"Do NOT propose, describe, or suggest changes; make them.",
		"",
		`Worktree: ${worktreePath}`,
	];
	if (prTitle) {
		lines.push(`PR: ${prTitle}`);
	}
	lines.push("");
	lines.push("FINDING");
	lines.push(`  id: ${finding.id}`);
	lines.push(`  label: ${finding.label}`);
	lines.push(`  location: ${where}`);
	lines.push(`  subject: ${finding.subject}`);
	lines.push(`  discussion: ${finding.discussion}`);
	if (userInstructions) {
		lines.push("");
		lines.push("USER INSTRUCTIONS");
		lines.push(userInstructions);
	}
	lines.push("");
	lines.push("STEPS");
	lines.push("1. Read the affected file(s) to understand context.");
	lines.push("2. Apply the change with your edit/write tools.");
	lines.push("3. Re-read the file to verify your edit landed correctly.");
	lines.push("");
	lines.push("OUTPUT");
	lines.push(
		"After applying the change, emit a single JSON object on its own line as your final output:",
	);
	lines.push("");
	lines.push("{");
	lines.push(`  "findingId": ${finding.id},`);
	lines.push('  "summary": "one-sentence description of what changed",');
	lines.push('  "modifiedFiles": ["path/relative/to/worktree.ts", "..."]');
	lines.push("}");
	lines.push("");
	lines.push(
		"If after investigation you conclude no change is needed, return `modifiedFiles: []` and explain why in `summary`.",
	);
	return lines.join("\n");
}

/**
 * Parse the subagent's stdout, looking for the last
 * JSON object and validating it against the FixOutput
 * shape.
 */
export function parseFixOutput(text: string): ParseFixResult {
	const json = extractLastJsonObject(text);
	if (json === null) {
		return { ok: false, error: "No JSON object found in subagent output." };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `JSON parse failed: ${message}` };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, error: "Subagent output was not a JSON object." };
	}
	const candidate = parsed as Record<string, unknown>;
	if (typeof candidate.findingId !== "number") {
		return { ok: false, error: "Missing or non-numeric `findingId`." };
	}
	if (typeof candidate.summary !== "string") {
		return { ok: false, error: "Missing or non-string `summary`." };
	}
	if (!Array.isArray(candidate.modifiedFiles)) {
		return { ok: false, error: "`modifiedFiles` must be an array." };
	}
	const files: string[] = [];
	for (const entry of candidate.modifiedFiles) {
		if (typeof entry !== "string") {
			return { ok: false, error: "`modifiedFiles` must contain only strings." };
		}
		files.push(entry);
	}
	return {
		ok: true,
		value: {
			findingId: candidate.findingId,
			summary: candidate.summary,
			modifiedFiles: files,
		},
	};
}

/**
 * Dispatch one fix subagent. The subagent applies edits
 * to files under `worktreePath` and returns a structured
 * summary. Side effects on disk are committed by the
 * subagent's own tools; this function only reports them.
 */
export async function runFix(options: RunFixOptions): Promise<RunFixResult> {
	const args = composeArgs(options);
	const prompt = buildFixPrompt({
		finding: options.finding,
		worktreePath: options.worktreePath,
		prTitle: options.prTitle,
		userInstructions: options.userInstructions,
	});
	args.push(prompt);

	const result = await options.runPi({
		args,
		cwd: options.worktreePath,
		signal: options.signal,
	});

	const usage = extractUsageFromPiStream(result.stdout);

	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || `exit ${result.exitCode}`;
		return {
			ok: false,
			error: `Fix subagent exit ${result.exitCode}: ${detail}`,
			stderr: result.stderr,
			...(usage ? { usage } : {}),
		};
	}

	const parsed = parseFixOutput(result.stdout);
	if (!parsed.ok) {
		return {
			ok: false,
			error: parsed.error,
			stderr: result.stderr,
			...(usage ? { usage } : {}),
		};
	}
	if (parsed.value.findingId !== options.finding.id) {
		return {
			ok: false,
			error: `Subagent returned wrong finding id: expected ${options.finding.id}, got ${parsed.value.findingId} (mismatch).`,
			stderr: result.stderr,
			...(usage ? { usage } : {}),
		};
	}
	return {
		ok: true,
		output: parsed.value,
		stderr: result.stderr,
		...(usage ? { usage } : {}),
	};
}

function composeArgs(options: RunFixOptions): string[] {
	const args: string[] = ["--mode", "json", "--no-session", "-p"];
	if (options.model) {
		args.push("--model", options.model);
	}
	if (options.tools.length > 0) {
		args.push("--tools", options.tools.join(","));
	}
	return args;
}

function extractLastJsonObject(text: string): string | null {
	// Walk backwards looking for matched braces. Models
	// often narrate before emitting JSON, so we want the
	// LAST object in the stream.
	let depth = 0;
	let end = -1;
	for (let i = text.length - 1; i >= 0; i--) {
		const ch = text[i];
		if (ch === "}") {
			if (depth === 0) end = i;
			depth++;
		} else if (ch === "{") {
			depth--;
			if (depth === 0 && end !== -1) {
				return text.slice(i, end + 1);
			}
		}
	}
	return null;
}

function renderLocation(loc: FindingLocation): string {
	switch (loc.kind) {
		case "line":
			return `${loc.file}:${loc.start}-${loc.end} (${loc.side})`;
		case "file":
			return loc.file;
		case "global":
			return "(global / scope-level)";
	}
}

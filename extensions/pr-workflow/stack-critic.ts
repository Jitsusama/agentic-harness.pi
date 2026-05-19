/**
 * Stack critic — one model that looks across every PR
 * in a stack and surfaces cross-PR findings.
 *
 * Where the judge consolidates round-1 outputs within a
 * single PR, the stack critic consolidates ACROSS PRs.
 * It reads each PR's judge findings (live for the
 * cursor PR, snapshotted for off-cursor PRs) plus title
 * and body, and emits a flat list of findings that
 * span multiple PRs.
 *
 * Each `StackFinding` carries:
 *   - `homePrNumber`: where the finding should post.
 *     Defaults to the cursor PR if the model can't
 *     pick a better home.
 *   - `spans`: every PR the finding talks about.
 *     Posting attaches all spans by reference in the
 *     finding body so the destination PR's readers
 *     know what else changed.
 *
 * Single reviewer, single subagent invocation. Mirrors
 * the judge module shape, not the council module
 * shape — the value here is wide-view synthesis, not
 * diversity of opinion (the council already provided
 * that per PR).
 */

import { Value } from "@sinclair/typebox/value";
import type { Finding, FindingLocation } from "./findings.js";
import type { CouncilReviewer, ReviewerUsage } from "./reviewer.js";
import { StackCriticFinding, StackCriticOutput } from "./schemas.js";

/**
 * A finding that talks about more than one PR in the
 * stack, or a finding that belongs to a specific PR but
 * was only visible by reading the whole stack.
 *
 * Inherits everything `Finding` carries (id, location,
 * label, subject, discussion, severity, confidence,
 * decorations) and adds the stack-aware fields.
 */
export interface StackFinding extends Finding {
	/** Which PR this finding should post to. */
	readonly homePrNumber: number;
	/** Every PR the finding refers to. Always includes `homePrNumber`. */
	readonly spans: readonly number[];
}

/** Result of one stack-critic round. */
export interface StackCriticRun {
	readonly id: string;
	readonly startedAt: string;
	readonly reviewerId: string;
	readonly findings: StackFinding[];
	readonly warnings: string[];
	/** Token + cost totals when the dispatcher surfaces them. */
	readonly usage?: ReviewerUsage;
}

/**
 * Stack-critic reviewer is configured separately from
 * judge so the user can pick a different model for
 * cross-PR pattern detection.
 */
export type StackCriticReviewer = CouncilReviewer;

/** One PR's slice of context passed to the stack critic. */
export interface StackCriticPrContext {
	readonly prNumber: number;
	readonly title: string;
	readonly body: string;
	readonly judgeFindings: readonly Finding[];
}

/** Inputs to `buildStackCriticPrompt`. */
export interface BuildStackCriticPromptInput {
	readonly cursorPrNumber: number;
	readonly perPr: readonly StackCriticPrContext[];
}

/** Inputs to `parseStackCriticOutput`. */
export interface StackCriticParseContext {
	readonly runId: string;
	readonly reviewerId: string;
	readonly startId: number;
}

/** Output of `parseStackCriticOutput`. */
export interface StackCriticParseResult {
	readonly findings: StackFinding[];
	readonly warnings: string[];
}

/**
 * Render the stack-critic prompt from the per-PR
 * context. The prompt presents every PR with its
 * identity, intent and consolidated judge findings, then
 * asks for cross-PR observations as a JSON list.
 */
export function buildStackCriticPrompt(
	input: BuildStackCriticPromptInput,
): string {
	const lines: string[] = [];
	lines.push(
		"You are the stack critic. The user is reviewing a stack of " +
			"pull requests that build on each other. Your job is to surface " +
			"observations that only become visible when you read the whole " +
			"stack together.",
	);
	lines.push("");
	lines.push(
		`The cursor is on PR #${input.cursorPrNumber}. When you can't pick a ` +
			"better destination for a finding, default `homePrNumber` to the " +
			"cursor PR.",
	);
	lines.push("");
	lines.push("Discipline:");
	lines.push(
		"- Look for cross-PR patterns: inconsistent error handling, " +
			"abstractions that shift between layers, duplicated logic " +
			"that should consolidate, API choices that only make sense " +
			"if a downstream PR lands.",
	);
	lines.push(
		"- One finding per pattern. Don't restate per-PR judge " +
			"findings; the user already saw those.",
	);
	lines.push(
		"- Empty findings list is a real, valid response. Don't " +
			"invent cross-PR issues just to fill space.",
	);
	lines.push(
		"- `spans` must list EVERY PR the finding refers to, " +
			"including the `homePrNumber`.",
	);
	lines.push("");
	lines.push("## Stack");
	for (const pr of input.perPr) {
		lines.push("");
		const cursor = pr.prNumber === input.cursorPrNumber ? " [cursor]" : "";
		lines.push(`### PR #${pr.prNumber}${cursor}: ${pr.title}`);
		if (pr.body.trim() !== "") {
			lines.push("");
			lines.push(pr.body);
		}
		lines.push("");
		if (pr.judgeFindings.length === 0) {
			lines.push("(no judge findings yet for this PR)");
			continue;
		}
		lines.push("Judge findings:");
		for (const finding of pr.judgeFindings) {
			const loc = renderLocation(finding.location);
			lines.push(
				`  [id=${finding.id}] [${finding.label}] ${finding.subject} ${loc}`,
			);
			lines.push(`    ${finding.discussion}`);
		}
	}
	lines.push("");
	lines.push(
		"Respond with a single fenced JSON block. No prose outside the block.",
	);
	lines.push("");
	lines.push("## JSON Schema");
	lines.push(
		"Your output must match this JSON Schema exactly. The same schema " +
			"is used by the `verify_output` tool you'll call below and by " +
			"the parent parser, so anything that passes the verifier will " +
			"be accepted.",
	);
	lines.push("```json");
	lines.push(JSON.stringify(StackCriticOutput, null, 2));
	lines.push("```");
	lines.push("");
	lines.push("## Self-verify before ending");
	lines.push(
		"Before you finish your run, call the `verify_output` tool with " +
			'stage: "stack-critic" and `output` set to the object you intend ' +
			"to emit. The tool returns `ok: true` with the parsed finding " +
			"count, or `ok: false` with a list of {path, message} errors. " +
			"If errors are reported, fix the offending fields and call " +
			"`verify_output` again. Only emit your final fenced JSON block " +
			"(and end the run) once the verifier returns `ok: true`. If the " +
			"verifier keeps reporting the same error after three attempts, " +
			"emit your best attempt and the parent will surface the warnings.",
	);
	return lines.join("\n");
}

function renderLocation(loc: FindingLocation): string {
	switch (loc.kind) {
		case "line":
			return `at ${loc.file}:${loc.start}-${loc.end} (${loc.side})`;
		case "file":
			return `at ${loc.file}`;
		case "global":
			return "(scope)";
	}
}

/**
 * Parse the stack critic's response into a flat
 * `StackFinding[]`. Resilient: malformed entries drop
 * rather than abort, and the warning trail explains
 * what was lost.
 */
export function parseStackCriticOutput(
	text: string,
	context: StackCriticParseContext,
): StackCriticParseResult {
	const jsonText = extractJson(text);
	if (jsonText === null) {
		return {
			findings: [],
			warnings: ["Stack critic response contained no JSON block"],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			findings: [],
			warnings: [`Stack critic JSON failed to parse: ${message}`],
		};
	}

	if (typeof parsed !== "object" || parsed === null) {
		return {
			findings: [],
			warnings: ["Stack critic JSON top-level was not an object"],
		};
	}
	const record = parsed as Record<string, unknown>;
	const rawFindings = Array.isArray(record.findings) ? record.findings : [];

	const findings: StackFinding[] = [];
	const warnings: string[] = [];
	let nextId = context.startId;
	for (let i = 0; i < rawFindings.length; i++) {
		const raw = rawFindings[i];
		if (!Value.Check(StackCriticFinding, raw)) {
			warnings.push(`Stack critic finding at index ${i} is malformed; skipped`);
			continue;
		}
		findings.push(toStackFinding(raw, nextId, context));
		nextId++;
	}

	return { findings, warnings };
}

function extractJson(text: string): string | null {
	const fenced = text.match(/```json\s*\n([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	const objectStart = text.indexOf("{");
	if (objectStart === -1) return null;
	return text.slice(objectStart);
}

/**
 * Build a `StackFinding` from a schema-validated raw
 * entry. The schema guarantees core fields are well
 * formed; this step stamps id, origin, derives
 * `category`, and copies `homePrNumber` and `spans`.
 */
function toStackFinding(
	raw: StackCriticFinding,
	id: number,
	context: StackCriticParseContext,
): StackFinding {
	const category: Finding["category"] =
		raw.location.kind === "global" ? "scope" : "file";
	return {
		id,
		location: raw.location,
		label: raw.label,
		decorations: raw.decorations ?? [],
		subject: raw.subject,
		discussion: raw.discussion,
		category,
		severity: raw.severity,
		confidence: raw.confidence,
		origin: {
			kind: "stack-critic",
			runId: context.runId,
			reviewerId: context.reviewerId,
		},
		state: "draft",
		homePrNumber: raw.homePrNumber,
		spans: [...raw.spans],
	};
}

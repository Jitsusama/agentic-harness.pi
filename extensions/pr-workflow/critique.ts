/**
 * Round 3 — critique (optional).
 *
 * The same roster that ran round 1 sees the judge's
 * consolidated list and stakes a position on each
 * finding: agree, disagree, qualify, or amplify, with
 * rationale. Critiques annotate findings; they never
 * remove them.
 *
 * Fan-out across the roster is concurrent against a
 * shared worktree, identical in shape to round 1. The
 * judge itself is not invited back; this round is the
 * original reviewers pushing back on the synthesis.
 *
 * Output is a `CritiqueRun` with one
 * `ReviewerCritiqueOutput` per reviewer. Downstream
 * code joins critiques to the consolidated findings by
 * `findingId` to render `agreement.dissent[]` to the
 * user.
 */

import type { CouncilDispatch, CouncilTarget } from "./council.js";
import type { CouncilRun, FindingLocation } from "./findings.js";
import type { JudgeRun } from "./judge.js";
import type { CouncilReviewer, ReviewerUsage } from "./reviewer.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Reviewer's stance on a single consolidated finding. */
export type CritiquePosition = "agree" | "disagree" | "qualify" | "amplify";

/** One reviewer's position on one consolidated finding. */
export interface CritiqueEntry {
	readonly reviewerId: string;
	readonly findingId: number;
	readonly position: CritiquePosition;
	readonly rationale: string;
}

/** One reviewer's critique output. */
export interface ReviewerCritiqueOutput {
	readonly reviewerId: string;
	readonly critiques: CritiqueEntry[];
	readonly warnings: string[];
	/**
	 * Token + cost totals for this reviewer's critique
	 * subagent. May be undefined when the dispatcher did
	 * not surface usage.
	 */
	readonly usage?: ReviewerUsage;
}

/** Result of one critique round. */
export interface CritiqueRun {
	readonly id: string;
	readonly startedAt: string;
	readonly judgeRunId: string;
	readonly reviewerOutputs: ReviewerCritiqueOutput[];
	readonly warnings: string[];
}

/** Inputs to `buildCritiquePrompt`. */
export interface BuildCritiquePromptInput {
	readonly reviewerId: string;
	readonly council: CouncilRun;
	readonly judge: JudgeRun;
}

/** Inputs to `parseCritiqueOutput`. */
export interface CritiqueParseContext {
	readonly runId: string;
	readonly reviewerId: string;
}

/** Output of `parseCritiqueOutput`. */
export interface CritiqueParseResult {
	readonly critiques: CritiqueEntry[];
	readonly warnings: string[];
}

/** Inputs to `runCritique`. */
export interface RunCritiqueOptions {
	readonly runId: string;
	readonly council: CouncilRun;
	readonly judge: JudgeRun;
	readonly roster: readonly CouncilReviewer[];
	readonly target: Pick<CouncilTarget, "owner" | "repo" | "sha">;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
}

const VALID_POSITIONS: ReadonlySet<CritiquePosition> = new Set([
	"agree",
	"disagree",
	"qualify",
	"amplify",
]);

/**
 * Render the critique prompt for a single reviewer. The
 * reviewer sees:
 *   - their own round-1 findings (so they recall their
 *     position before reading the synthesis)
 *   - every consolidated finding with id, location,
 *     label, and `raisedBy` attribution
 *   - the four allowed positions and the JSON output
 *     schema
 */
export function buildCritiquePrompt(input: BuildCritiquePromptInput): string {
	const lines: string[] = [];
	lines.push(
		`You are reviewer "${input.reviewerId}" in a multi-model code-review council. ` +
			"A judge has consolidated everyone's round-1 findings into the " +
			"list below. Take a position on EACH consolidated finding by id.",
	);
	lines.push("");
	lines.push("Allowed positions:");
	lines.push("  - agree: the finding is correct as stated.");
	lines.push(
		"  - disagree: the finding is wrong, misleading, or doesn't " +
			"apply. Say why.",
	);
	lines.push(
		"  - qualify: the finding is partially right; narrow or soften " +
			"it. Say how.",
	);
	lines.push(
		"  - amplify: the finding is correct AND undersold; mark it more " +
			"severe or blocking. Say why.",
	);
	lines.push("");
	lines.push("Your round-1 findings (for recall):");
	const own = input.council.reviewerOutputs.find(
		(o) => o.reviewerId === input.reviewerId,
	);
	if (own && own.findings.length > 0) {
		for (const finding of own.findings) {
			lines.push(
				`  [your id=${finding.id}] [${finding.label}] ${finding.subject} ${renderLocation(finding.location)}`,
			);
			lines.push(`    ${finding.discussion}`);
		}
	} else {
		lines.push("  (none)");
	}
	lines.push("");
	lines.push("Consolidated findings to critique:");
	if (input.judge.consolidatedFindings.length === 0) {
		lines.push("  (none)");
	}
	for (const finding of input.judge.consolidatedFindings) {
		const raisedBy = finding.agreement?.raisedBy ?? [];
		const attribution =
			raisedBy.length > 0
				? ` (raised by: ${raisedBy.join(", ")})`
				: " (judge synthesis)";
		lines.push(
			`  [id=${finding.id}] [${finding.label}] ${finding.subject} ${renderLocation(finding.location)}${attribution}`,
		);
		lines.push(`    ${finding.discussion}`);
	}
	lines.push("");
	lines.push("Respond with a single fenced JSON block:");
	lines.push("```json");
	lines.push("{");
	lines.push('  "critiques": [');
	lines.push("    {");
	lines.push('      "findingId": 10,');
	lines.push('      "position": "agree" | "disagree" | "qualify" | "amplify",');
	lines.push('      "rationale": "one or two sentences"');
	lines.push("    }");
	lines.push("  ]");
	lines.push("}");
	lines.push("```");
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
 * Parse a reviewer's critique response. Resilient: bad
 * entries drop, others are kept. Warnings surface what
 * went wrong.
 */
export function parseCritiqueOutput(
	text: string,
	context: CritiqueParseContext,
): CritiqueParseResult {
	const jsonText = extractJson(text);
	if (jsonText === null) {
		return {
			critiques: [],
			warnings: ["Critique response contained no JSON block"],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			critiques: [],
			warnings: [`Critique JSON failed to parse: ${message}`],
		};
	}
	if (typeof parsed !== "object" || parsed === null) {
		return {
			critiques: [],
			warnings: ["Critique JSON top-level was not an object"],
		};
	}
	const record = parsed as Record<string, unknown>;
	const rawCritiques = Array.isArray(record.critiques) ? record.critiques : [];

	const critiques: CritiqueEntry[] = [];
	const warnings: string[] = [];
	for (let i = 0; i < rawCritiques.length; i++) {
		const entry = toCritiqueEntry(rawCritiques[i], context);
		if (entry === null) {
			warnings.push(`Critique at index ${i} is malformed; skipped`);
			continue;
		}
		critiques.push(entry);
	}
	return { critiques, warnings };
}

function extractJson(text: string): string | null {
	const fenced = text.match(/```json\s*\n([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	const objectStart = text.indexOf("{");
	if (objectStart === -1) return null;
	return text.slice(objectStart);
}

function toCritiqueEntry(
	raw: unknown,
	context: CritiqueParseContext,
): CritiqueEntry | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const findingId = r.findingId;
	if (typeof findingId !== "number" || !Number.isFinite(findingId)) {
		return null;
	}
	const position = r.position;
	if (
		typeof position !== "string" ||
		!VALID_POSITIONS.has(position as CritiquePosition)
	) {
		return null;
	}
	const rationale = r.rationale;
	if (typeof rationale !== "string" || rationale.trim().length === 0) {
		return null;
	}
	return {
		reviewerId: context.reviewerId,
		findingId,
		position: position as CritiquePosition,
		rationale,
	};
}

/**
 * Fan out the roster across one shared worktree. Each
 * reviewer's pi subagent runs concurrently. Errors are
 * captured per reviewer (via warnings) rather than
 * aborting the run.
 */
export async function runCritique(
	options: RunCritiqueOptions,
): Promise<CritiqueRun> {
	const handle = await options.registry.ensure({
		owner: options.target.owner,
		repo: options.target.repo,
		sha: options.target.sha,
	});

	const promises = options.roster.map(async (reviewer) => {
		const prompt = buildCritiquePrompt({
			reviewerId: reviewer.id,
			council: options.council,
			judge: options.judge,
		});
		const dispatched = await options.dispatch({
			reviewer,
			prompt,
			cwd: handle.path,
			signal: options.signal,
		});
		const parsed = parseCritiqueOutput(dispatched.finalAssistantText, {
			runId: options.runId,
			reviewerId: reviewer.id,
		});
		const output: ReviewerCritiqueOutput = {
			reviewerId: reviewer.id,
			critiques: parsed.critiques,
			warnings: [...dispatched.warnings, ...parsed.warnings],
			...(dispatched.usage ? { usage: dispatched.usage } : {}),
		};
		return output;
	});

	const settled = await Promise.allSettled(promises);
	const reviewerOutputs: ReviewerCritiqueOutput[] = [];
	const runWarnings: string[] = [];
	for (let i = 0; i < settled.length; i++) {
		const result = settled[i];
		if (result.status === "fulfilled") {
			reviewerOutputs.push(result.value);
		} else {
			const reviewerId = options.roster[i].id;
			const message =
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason);
			reviewerOutputs.push({
				reviewerId,
				critiques: [],
				warnings: [`Critique dispatch failed: ${message}`],
			});
			runWarnings.push(`Reviewer ${reviewerId} threw: ${message}`);
		}
	}

	return {
		id: options.runId,
		startedAt: new Date().toISOString(),
		judgeRunId: options.judge.id,
		reviewerOutputs,
		warnings: runWarnings,
	};
}

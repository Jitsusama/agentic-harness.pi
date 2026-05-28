/**
 * Round 4 — user synthesis.
 *
 * The user reads the council pipeline output and takes
 * positions on findings. This module owns:
 *
 *   - the `FindingDecision` shape (one verdict per
 *     finding plus content needed by that verdict)
 *   - `decideFinding(state, input)` to record / revise
 *     a decision
 *   - `formatFindingsView(state)` to render the
 *     pipeline + decisions as a single read-only view
 *
 * Posting decisions to GitHub belongs in a later slice.
 * Promotion to a draft review body also belongs later;
 * the verdict alone records the user's position.
 */

import type { CritiquePosition, CritiqueRun } from "./critique.js";
import type {
	ConventionalLabel,
	Finding,
	FindingLocation,
} from "./findings.js";
import type { FindingSide } from "./schemas.js";
import type { PrWorkflowState } from "./state.js";
import { renderThreadRelation } from "./thread-context.js";

const SIDES: ReadonlySet<FindingSide> = new Set(["old", "new", "both"]);

/**
 * The user's verdict on a single consolidated finding.
 * Discriminated union so each verdict carries only the
 * fields it actually needs.
 */
export type FindingDecision =
	| {
			readonly findingId: number;
			readonly verdict: "endorse";
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "qualify";
			readonly note: string;
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "edit";
			readonly subject?: string;
			readonly discussion?: string;
			readonly label?: ConventionalLabel;
			/** Optional location override applied to the finding's `location`. */
			readonly location?: FindingLocation;
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "dismiss";
			readonly reason?: string;
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "promote";
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "fix";
			readonly instructions?: string;
			readonly decidedAt: string;
			/**
			 * Set by `recordFixDone` after the user (or agent
			 * acting on their behalf) lands a commit that
			 * addresses this finding. Mutually exclusive with
			 * `skipped`.
			 */
			readonly resolvedBy?: {
				readonly commitSha: string;
				readonly recordedAt: string;
			};
			/**
			 * Set by `recordFixSkip` when the user decides not
			 * to land the queued fix after all. Mutually
			 * exclusive with `resolvedBy`.
			 */
			readonly skipped?: {
				readonly reason: string;
				readonly recordedAt: string;
			};
	  };

/** Result of a decision mutation. */
export type DecisionResult = { ok: true } | { ok: false; error: string };

/**
 * Which set of findings the decision targets. Defaults
 * to `"pr"` (the per-PR judge findings in
 * `state.council.lastJudge`). `"stack"` routes the
 * decision to `state.stackDecisions` against the most
 * recent `state.stackFindingRun` run.
 */
export type DecideFindingScope = "pr" | "stack";

type WithScope<T> = T & { readonly scope?: DecideFindingScope };

/** Inputs to `decideFinding`, without the timestamp. */
export type DecideFindingInput = WithScope<
	| { findingId: number; verdict: "endorse" }
	| { findingId: number; verdict: "qualify"; note: string }
	| {
			findingId: number;
			verdict: "edit";
			subject?: string;
			discussion?: string;
			label?: ConventionalLabel;
			/** Inline location-override fields, flattened to mirror `add-finding`. */
			file?: string;
			start?: number;
			end?: number;
			side?: FindingSide;
	  }
	| { findingId: number; verdict: "dismiss"; reason?: string }
	| { findingId: number; verdict: "promote" }
	| { findingId: number; verdict: "fix"; instructions?: string }
>;

/**
 * Record or overwrite the user's decision on one finding.
 * Validates the input shape (qualify needs a note; edit
 * needs subject and/or discussion) and that the finding
 * id exists in the most-recent judge run.
 */
export function decideFinding(
	state: PrWorkflowState,
	input: DecideFindingInput,
	now: () => Date = () => new Date(),
): DecisionResult {
	const scope: DecideFindingScope = input.scope ?? "pr";
	const lookup = lookupFinding(state, input.findingId, scope);
	if (!lookup.ok) return lookup;

	const validation = validateInput(state, input);
	if (!validation.ok) return validation;

	const decidedAt = now().toISOString();
	const original = findOriginalFinding(state, input);
	const decision: FindingDecision = buildDecision(
		input,
		decidedAt,
		original?.location,
	);
	if (scope === "stack") {
		state.stackDecisions.set(input.findingId, decision);
	} else {
		state.council.decisions.set(input.findingId, decision);
	}
	return { ok: true };
}

/**
 * Resolve a finding id against the scope-appropriate
 * source. Returns a failure result with a scope-specific
 * error when the source isn't populated or the id
 * doesn't exist.
 */
function lookupFinding(
	state: PrWorkflowState,
	findingId: number,
	scope: DecideFindingScope,
): DecisionResult {
	if (scope === "stack") {
		if (state.stackFindingRun === null) {
			return {
				ok: false,
				error:
					"No cross-PR run available. Run pr_workflow action=cross-PR first.",
			};
		}
		const exists = state.stackFindingRun.findings.some(
			(f) => f.id === findingId,
		);
		if (!exists) {
			return {
				ok: false,
				error: `Unknown stack findingId ${findingId}: not in the most-recent cross-PR run.`,
			};
		}
		return { ok: true };
	}
	const judge = state.council.lastJudge;
	if (judge === null) {
		return {
			ok: false,
			error:
				"No findings to decide on. Run pr_workflow action=council, then action=judge first.",
		};
	}
	const exists = judge.consolidatedFindings.some((f) => f.id === findingId);
	if (!exists) {
		return {
			ok: false,
			error: `Unknown findingId ${findingId}: not in the most-recent judge run.`,
		};
	}
	return { ok: true };
}

function validateInput(
	state: PrWorkflowState,
	input: DecideFindingInput,
): DecisionResult {
	if (input.verdict === "qualify") {
		if (input.note.trim().length === 0) {
			return {
				ok: false,
				error:
					"qualify verdict requires a non-empty `note`. Say what to soften or qualify.",
			};
		}
	}
	if (input.verdict === "edit") {
		const subjectGiven =
			typeof input.subject === "string" && input.subject.trim().length > 0;
		const discussionGiven =
			typeof input.discussion === "string" &&
			input.discussion.trim().length > 0;
		const labelGiven = typeof input.label === "string";
		const locationGiven = hasLocationOverride(input);
		if (!subjectGiven && !discussionGiven && !labelGiven && !locationGiven) {
			return {
				ok: false,
				error:
					"edit verdict requires at least one of `subject`, `discussion`, `label` or a location override (`file`, `start`, `end`, `side`).",
			};
		}
		if (locationGiven) {
			const original = findOriginalFinding(state, input);
			if (original) {
				const locationCheck = resolveLocationOverride(original.location, input);
				if (!locationCheck.ok) return locationCheck;
			}
		}
	}
	return { ok: true };
}

interface LocationOverrideInput {
	readonly file?: string;
	readonly start?: number;
	readonly end?: number;
	readonly side?: FindingSide;
}

function hasLocationOverride(input: LocationOverrideInput): boolean {
	return (
		input.file !== undefined ||
		input.start !== undefined ||
		input.end !== undefined ||
		input.side !== undefined
	);
}

function findOriginalFinding(
	state: PrWorkflowState,
	input: DecideFindingInput,
): Finding | null {
	const scope: DecideFindingScope = input.scope ?? "pr";
	if (scope === "stack") {
		return (
			state.stackFindingRun?.findings.find((f) => f.id === input.findingId) ??
			null
		);
	}
	return (
		state.council.lastJudge?.consolidatedFindings.find(
			(f) => f.id === input.findingId,
		) ?? null
	);
}

/**
 * Apply a partial location patch on top of an existing
 * finding location.
 *
 *   - `start` (with or without `end`/`side`) projects to
 *     line-kind. The file is taken from the override or
 *     inherited from the original; if neither is
 *     available we reject.
 *   - `file` alone drops to file-kind on the new file,
 *     discarding any prior line range.
 *   - `side` alone is only valid when the original is
 *     line-kind; mirrors the `add-finding` constraint
 *     that side only applies to line locations.
 *   - An empty patch returns the original location.
 *
 * `end` defaults to `start`; `side` defaults to the
 * original's `side` when the result is line-kind, or
 * `"new"` when promoting a non-line finding.
 */
function resolveLocationOverride(
	original: FindingLocation,
	override: LocationOverrideInput,
): { ok: true; location: FindingLocation } | { ok: false; error: string } {
	if (!hasLocationOverride(override)) {
		return { ok: true, location: original };
	}
	const originalFile =
		original.kind === "line" || original.kind === "file"
			? original.file
			: undefined;
	const file = override.file ?? originalFile;
	const hasLineFields =
		override.start !== undefined || override.end !== undefined;
	if (override.side !== undefined && !SIDES.has(override.side)) {
		return { ok: false, error: `Unknown finding side: ${override.side}` };
	}
	if (hasLineFields) {
		if (!file) {
			return {
				ok: false,
				error:
					"Line override requires a `file`; the original finding has none to inherit.",
			};
		}
		const start = override.start;
		if (start === undefined || !Number.isInteger(start) || start < 1) {
			return {
				ok: false,
				error: "Line override requires a positive integer `start`.",
			};
		}
		const end = override.end ?? start;
		if (!Number.isInteger(end) || end < 1) {
			return {
				ok: false,
				error: "Line override `end` must be a positive integer.",
			};
		}
		if (end < start) {
			return {
				ok: false,
				error: "Line override `end` must be greater than or equal to `start`.",
			};
		}
		const side =
			override.side ?? (original.kind === "line" ? original.side : "new");
		return { ok: true, location: { kind: "line", file, start, end, side } };
	}
	if (override.file !== undefined) {
		return { ok: true, location: { kind: "file", file: override.file } };
	}
	// Side-only override: only meaningful on a line-kind
	// finding. Mirrors add-finding's "side only applies to
	// line findings" rule.
	if (original.kind !== "line") {
		return {
			ok: false,
			error: "`side` override only applies to line findings.",
		};
	}
	return {
		ok: true,
		location: { ...original, side: override.side ?? original.side },
	};
}

/**
 * Collapse a whitespace-only override to `undefined`
 * so it doesn't survive into the posted header. The
 * "at least one of" rule in `validateInput` already
 * trims to decide whether a field counts as provided;
 * `effectiveSubject` and friends only fall back to the
 * original when the override is nullish, so an empty
 * string would otherwise blank the comment.
 */
function normalizeOverride(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim().length === 0 ? undefined : value;
}

function maybeLocation(
	original: FindingLocation,
	override: LocationOverrideInput,
): { location?: FindingLocation } {
	const resolved = resolveLocationOverride(original, override);
	return resolved.ok ? { location: resolved.location } : {};
}

function buildDecision(
	input: DecideFindingInput,
	decidedAt: string,
	originalLocation: FindingLocation | undefined,
): FindingDecision {
	switch (input.verdict) {
		case "endorse":
			return { findingId: input.findingId, verdict: "endorse", decidedAt };
		case "qualify":
			return {
				findingId: input.findingId,
				verdict: "qualify",
				note: input.note,
				decidedAt,
			};
		case "edit":
			return {
				findingId: input.findingId,
				verdict: "edit",
				subject: normalizeOverride(input.subject),
				discussion: normalizeOverride(input.discussion),
				label: input.label,
				...(hasLocationOverride(input) && originalLocation
					? maybeLocation(originalLocation, input)
					: {}),
				decidedAt,
			};
		case "dismiss":
			return {
				findingId: input.findingId,
				verdict: "dismiss",
				reason: input.reason,
				decidedAt,
			};
		case "promote":
			return { findingId: input.findingId, verdict: "promote", decidedAt };
		case "fix":
			return {
				findingId: input.findingId,
				verdict: "fix",
				instructions: input.instructions,
				decidedAt,
			};
	}
}

/**
 * Render the user's view of the pipeline state: each
 * consolidated finding with its critique dissent and
 * current decision (or "pending"). The output is what
 * the agent surfaces during round-4 conversation.
 */
export function formatFindingsView(state: PrWorkflowState): string {
	const judge = state.council.lastJudge;
	if (judge === null) {
		return "No findings yet. Run pr_workflow action=council, then action=judge.";
	}
	if (
		judge.consolidatedFindings.length === 0 &&
		state.stackFindingRun === null
	) {
		return "Judge consolidated 0 findings; nothing to decide on.";
	}
	const lines: string[] = [];
	for (const finding of judge.consolidatedFindings) {
		const decision = state.council.decisions.get(finding.id) ?? null;
		const display = effectiveFinding(finding, decision);
		lines.push(
			`[${finding.id}] [${display.label}] ${display.subject} ${renderLocation(finding.location)}`,
		);
		const raisedBy = finding.agreement?.raisedBy ?? [];
		if (raisedBy.length > 0) {
			lines.push(`   raised by: ${raisedBy.join(", ")}`);
		}
		const relation = renderThreadRelation(finding.threadRelation);
		if (relation !== null) {
			lines.push(`   thread: ${relation}`);
		}
		lines.push(`   ${display.discussion}`);
		const critiquesForFinding = collectCritiques(state, finding.id);
		for (const c of critiquesForFinding) {
			lines.push(
				`   critique [${c.reviewerId}]: ${c.position} — ${c.rationale}`,
			);
		}
		lines.push(`   decision: ${renderDecision(decision)}`);
		pushEditOriginals(lines, finding, decision);
		lines.push("");
	}
	if (
		state.stackFindingRun !== null &&
		state.stackFindingRun.findings.length > 0
	) {
		lines.push("Stack-level findings (decide with scope=stack):");
		lines.push("");
		for (const finding of state.stackFindingRun.findings) {
			const decision = state.stackDecisions.get(finding.id) ?? null;
			const display = effectiveFinding(finding, decision);
			lines.push(
				`[S${finding.id}] [${display.label}] ${display.subject} (home: #${finding.homePrNumber}; spans: ${finding.spans.join(", ")})`,
			);
			lines.push(`   ${display.discussion}`);
			const critiquesForFinding = collectStackCritiques(state, finding.id);
			for (const c of critiquesForFinding) {
				lines.push(
					`   critique [${c.reviewerId}]: ${c.position} — ${c.rationale}`,
				);
			}
			lines.push(`   decision: ${renderDecision(decision)}`);
			pushEditOriginals(lines, finding, decision);
			lines.push("");
		}
	}
	return lines.join("\n").trimEnd();
}

function collectCritiques(
	state: PrWorkflowState,
	findingId: number,
): {
	reviewerId: string;
	position: CritiquePosition;
	rationale: string;
}[] {
	return collectCritiquesFromRun(state.council.lastCritique, findingId);
}

function collectStackCritiques(
	state: PrWorkflowState,
	findingId: number,
): {
	reviewerId: string;
	position: CritiquePosition;
	rationale: string;
}[] {
	return collectCritiquesFromRun(
		state.stackFindingRun?.critique ?? null,
		findingId,
	);
}

function collectCritiquesFromRun(
	critique: CritiqueRun | null,
	findingId: number,
): {
	reviewerId: string;
	position: CritiquePosition;
	rationale: string;
}[] {
	if (critique === null) return [];
	const out: {
		reviewerId: string;
		position: CritiquePosition;
		rationale: string;
	}[] = [];
	for (const output of critique.reviewerOutputs) {
		const entry = output.critiques.find((c) => c.findingId === findingId);
		if (entry) {
			out.push({
				reviewerId: entry.reviewerId,
				position: entry.position,
				rationale: entry.rationale,
			});
		}
	}
	return out;
}

/**
 * Render the pre-edit field values under a decision so
 * the user can see what they changed from. Only emits a
 * line for fields the decision actually overrode.
 */
function pushEditOriginals(
	lines: string[],
	finding: Finding,
	decision: FindingDecision | null,
): void {
	if (decision?.verdict !== "edit") return;
	if (typeof decision.subject === "string") {
		lines.push(`     original subject: ${finding.subject}`);
	}
	if (typeof decision.discussion === "string") {
		lines.push(`     original discussion: ${finding.discussion}`);
	}
	if (typeof decision.label === "string") {
		lines.push(`     original label: ${finding.label}`);
	}
	if (decision.location !== undefined) {
		lines.push(`     original location: ${renderLocation(finding.location)}`);
	}
}

/**
 * Project a finding through any `edit` decision the
 * user recorded against it. Returns a same-shape
 * finding with `subject`, `discussion` and `label`
 * replaced by the user's overrides where present.
 *
 * Every downstream consumer (the wall-of-text view,
 * the compact view, the posted Conventional Comments
 * header, the review-body verdict path) reads from
 * the projected finding so a single rule—“the user's
 * edit wins”—lives in one place.
 */
export function effectiveFinding<T extends Finding>(
	finding: T,
	decision: FindingDecision | null,
): T {
	if (decision?.verdict !== "edit") return finding;
	return {
		...finding,
		subject: decision.subject ?? finding.subject,
		discussion: decision.discussion ?? finding.discussion,
		label: decision.label ?? finding.label,
		location: decision.location ?? finding.location,
	};
}

function renderDecision(decision: FindingDecision | null): string {
	if (decision === null) return "pending";
	switch (decision.verdict) {
		case "endorse":
			return "endorse";
		case "qualify":
			return `qualify — ${decision.note}`;
		case "edit":
			return "edit (see overrides above)";
		case "dismiss":
			return decision.reason ? `dismiss — ${decision.reason}` : "dismiss";
		case "promote":
			return "promote";
		case "fix":
			if (decision.resolvedBy) {
				return `✓ fixed in ${decision.resolvedBy.commitSha}`;
			}
			if (decision.skipped) {
				return `fix skipped — ${decision.skipped.reason}`;
			}
			return decision.instructions
				? `queued for fix — ${decision.instructions}`
				: "queued for fix";
	}
}

function renderLocation(loc: FindingLocation): string {
	switch (loc.kind) {
		case "line":
			return `(${loc.file}:${loc.start}-${loc.end})`;
		case "file":
			return `(${loc.file})`;
		case "global":
			return "(scope)";
	}
}

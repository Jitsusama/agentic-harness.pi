/** Add user-authored findings to the current review list. */

import { reserveFindingIds } from "./finding-ids.js";
import type { Finding, FindingLocation } from "./findings.js";
import type {
	ConventionalLabel,
	FindingSeverity,
	FindingSide,
} from "./schemas.js";
import type { PrWorkflowState } from "./state.js";

const LABELS: ReadonlySet<ConventionalLabel> = new Set([
	"praise",
	"nitpick",
	"suggestion",
	"issue",
	"todo",
	"question",
	"thought",
	"chore",
	"note",
]);
const SEVERITIES: ReadonlySet<FindingSeverity> = new Set([
	"critical",
	"medium",
	"minor",
]);
const SIDES: ReadonlySet<FindingSide> = new Set(["old", "new", "both"]);

/** Inputs for adding a manual finding to the current PR finding list. */
export interface AddManualFindingInput {
	readonly state: PrWorkflowState;
	readonly label: ConventionalLabel;
	readonly subject: string;
	readonly discussion: string;
	readonly decorations?: readonly string[];
	readonly severity?: FindingSeverity;
	readonly confidence?: number;
	readonly file?: string;
	readonly start?: number;
	readonly end?: number;
	readonly side?: FindingSide;
	readonly originNote?: string;
}

/** Result of adding a manual finding. */
export type AddManualFindingResult =
	| { ok: true; finding: Finding }
	| { ok: false; error: string };

/**
 * Append a user-authored finding to the latest judge run.
 *
 * Manual findings enter the same Round 4 surface as judge
 * findings, so the user can decide, fix or post them with
 * the existing workflow actions.
 */
export function addManualFindingAction(
	input: AddManualFindingInput,
): AddManualFindingResult {
	const judge = input.state.council.lastJudge;
	if (judge === null) {
		return {
			ok: false,
			error:
				"No judge findings available. Run pr_workflow action=council, then action=judge before adding manual findings.",
		};
	}

	const validation = validateInput(input);
	if (!validation.ok) return validation;

	const id = reserveFindingIds(input.state, 1);
	const location = buildLocation(input);
	const finding: Finding = {
		id,
		location,
		label: input.label,
		decorations: normalizeDecorations(input.decorations),
		subject: input.subject.trim(),
		discussion: input.discussion.trim(),
		category: location.kind === "global" ? "scope" : "file",
		severity: input.severity,
		confidence: input.confidence,
		origin: buildOrigin(input.originNote),
		state: "draft",
	};

	input.state.council.lastJudge = {
		...judge,
		consolidatedFindings: [...judge.consolidatedFindings, finding],
	};
	return { ok: true, finding };
}

function validateInput(
	input: AddManualFindingInput,
): { ok: true } | { ok: false; error: string } {
	if (!LABELS.has(input.label)) {
		return {
			ok: false,
			error: `Unknown Conventional Comment label: ${input.label}`,
		};
	}
	if (input.subject.trim().length === 0) {
		return { ok: false, error: "Manual finding subject cannot be empty." };
	}
	if (input.discussion.trim().length === 0) {
		return { ok: false, error: "Manual finding discussion cannot be empty." };
	}
	if (input.severity !== undefined && !SEVERITIES.has(input.severity)) {
		return { ok: false, error: `Unknown finding severity: ${input.severity}` };
	}
	if (
		input.confidence !== undefined &&
		(input.confidence < 0 || input.confidence > 1)
	) {
		return {
			ok: false,
			error: "Manual finding confidence must be between 0 and 1.",
		};
	}
	return validateLocation(input);
}

function validateLocation(
	input: AddManualFindingInput,
): { ok: true } | { ok: false; error: string } {
	const file = input.file?.trim() ?? "";
	const hasLine = input.start !== undefined || input.end !== undefined;
	if (!hasLine) {
		if (input.side !== undefined) {
			return {
				ok: false,
				error: "Manual finding side only applies to line findings.",
			};
		}
		return { ok: true };
	}
	if (file.length === 0) {
		return { ok: false, error: "Line findings require a non-empty `file`." };
	}
	if (!isPositiveInteger(input.start)) {
		return {
			ok: false,
			error: "Line findings require a positive integer `start`.",
		};
	}
	const end = input.end ?? input.start;
	if (!isPositiveInteger(end)) {
		return {
			ok: false,
			error: "Line finding `end` must be a positive integer.",
		};
	}
	if (end < input.start) {
		return {
			ok: false,
			error: "Line finding `end` must be greater than or equal to `start`.",
		};
	}
	if (input.side !== undefined && !SIDES.has(input.side)) {
		return { ok: false, error: `Unknown finding side: ${input.side}` };
	}
	return { ok: true };
}

function buildLocation(input: AddManualFindingInput): FindingLocation {
	const file = input.file?.trim() ?? "";
	if (input.start !== undefined) {
		return {
			kind: "line",
			file,
			start: input.start,
			end: input.end ?? input.start,
			side: input.side ?? "new",
		};
	}
	if (file.length > 0) return { kind: "file", file };
	return { kind: "global" };
}

function normalizeDecorations(
	decorations: readonly string[] | undefined,
): string[] {
	return (decorations ?? [])
		.map((decoration) => decoration.trim())
		.filter((decoration) => decoration.length > 0);
}

function buildOrigin(note: string | undefined): Finding["origin"] {
	const trimmed = note?.trim();
	return trimmed ? { kind: "user", note: trimmed } : { kind: "user" };
}

function isPositiveInteger(value: number | undefined): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

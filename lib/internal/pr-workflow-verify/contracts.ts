/**
 * Per-stage validation contracts for reviewer subagents.
 *
 * Each contract pairs a schema with the stage-specific
 * counters and semantic checks that go beyond what the
 * schema enforces. The five per-stage verify extensions
 * (`lib/internal/pr-workflow-verify/packs/{stage}.ts`) each import
 * one of these contracts and register `verify_output` from
 * `./extension.ts`.
 *
 * Contracts live here rather than inline in each extension
 * so the test suite can validate them directly without
 * spinning up the extension runtime, and so stage-specific
 * vocabulary stays in one place.
 */

import {
	CouncilFindingsOutput,
	CritiqueOutput,
	JudgeOutput,
	StackJudgeOutput,
	StackReviewOutput,
} from "../../../extensions/pr-workflow/schemas.js";
import {
	checkJudgeSelfSignal,
	checkPerPrKeys,
	checkTextArray,
	type StageContract,
	type ValidationError,
} from "./validate.js";

export const councilContract: StageContract = {
	stage: "council",
	schema: CouncilFindingsOutput,
	topLevelHint: 'Expected top-level shape: { "findings": [...] }.',
	itemCount(input) {
		const obj = input as { findings?: unknown[] };
		return obj.findings?.length ?? 0;
	},
	semanticChecks(input) {
		const obj = input as { findings?: unknown[] };
		return checkTextArray(obj.findings ?? [], "/findings", [
			"subject",
			"discussion",
		]);
	},
};

export const judgeContract: StageContract = {
	stage: "judge",
	schema: JudgeOutput,
	topLevelHint: 'Expected top-level shape: { "findings": [...] }.',
	itemCount(input) {
		const obj = input as { findings?: unknown[] };
		return obj.findings?.length ?? 0;
	},
	semanticChecks(input) {
		const obj = input as { findings?: unknown[] };
		const errors: ValidationError[] = [];
		errors.push(...checkJudgeSelfSignal(input));
		errors.push(
			...checkTextArray(obj.findings ?? [], "/findings", [
				"subject",
				"discussion",
			]),
		);
		return errors;
	},
};

export const critiqueContract: StageContract = {
	stage: "critique",
	schema: CritiqueOutput,
	topLevelHint: 'Expected top-level shape: { "critiques": [...] }.',
	itemCount(input) {
		const obj = input as { critiques?: unknown[] };
		return obj.critiques?.length ?? 0;
	},
	semanticChecks(input) {
		const obj = input as { critiques?: unknown[] };
		return checkTextArray(obj.critiques ?? [], "/critiques", ["rationale"]);
	},
};

export const stackReviewContract: StageContract = {
	stage: "stack-review",
	schema: StackReviewOutput,
	topLevelHint:
		'Expected top-level shape: { "perPr": { "123": [...] }, "crossPr": [...] }.',
	itemCount(input) {
		const obj = input as {
			perPr?: Record<string, unknown[]>;
			crossPr?: unknown[];
		};
		return perPrCount(obj.perPr) + (obj.crossPr?.length ?? 0);
	},
	semanticChecks(input) {
		return stackSemanticChecks(input);
	},
};

export const stackJudgeContract: StageContract = {
	stage: "stack-judge",
	schema: StackJudgeOutput,
	topLevelHint:
		'Expected top-level shape: { "perPr": { "123": [...] }, "crossPr": [...] }.',
	itemCount(input) {
		const obj = input as {
			perPr?: Record<string, unknown[]>;
			crossPr?: unknown[];
		};
		return perPrCount(obj.perPr) + (obj.crossPr?.length ?? 0);
	},
	semanticChecks(input) {
		const errors: ValidationError[] = [];
		errors.push(...checkJudgeSelfSignal(input));
		errors.push(...stackSemanticChecks(input));
		return errors;
	},
};

function stackSemanticChecks(input: unknown): ValidationError[] {
	const obj = input as {
		perPr?: Record<string, unknown[]>;
		crossPr?: unknown[];
	};
	const errors: ValidationError[] = [];
	errors.push(...checkPerPrKeys(input));
	for (const [prNumber, findings] of Object.entries(obj.perPr ?? {})) {
		errors.push(
			...checkTextArray(findings, `/perPr/${prNumber}`, [
				"subject",
				"discussion",
			]),
		);
	}
	errors.push(
		...checkTextArray(obj.crossPr ?? [], "/crossPr", ["subject", "discussion"]),
	);
	return errors;
}

function perPrCount(perPr: Record<string, unknown[]> | undefined): number {
	if (!perPr) return 0;
	return Object.values(perPr).reduce(
		(sum, findings) => sum + findings.length,
		0,
	);
}

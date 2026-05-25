/**
 * Schema validator for reviewer-subagent outputs.
 *
 * Pure. Takes a stage name and an arbitrary JSON-like
 * input, runs `Value.Check` against the matching schema
 * and surfaces the errors in a flat, easy-to-read shape.
 *
 * The verify tool wraps this and presents the result back
 * to the subagent. Anything that mattered for "is this
 * acceptable output?" lives here so it's testable without
 * spinning up the extension runtime.
 */

import { Value } from "@sinclair/typebox/value";
import { getSchema, type StageName } from "../../pr-workflow/schemas.js";

/** One row of validation feedback for the subagent. */
export interface ValidationError {
	/** JSON pointer into the input, e.g. `/findings/0/subject`. */
	readonly path: string;
	/** Human-readable explanation from the schema engine. */
	readonly message: string;
	/** Concrete repair advice the subagent can apply on the next call. */
	readonly hint?: string;
}

/** Result of validating one payload. */
export type ValidateResult =
	| {
			readonly ok: true;
			readonly count: number;
			readonly warnings?: readonly string[];
	  }
	| {
			readonly ok: false;
			readonly errors: ValidationError[];
			readonly warnings?: readonly string[];
	  };

const ALLOWED_STAGES: ReadonlyArray<StageName> = [
	"council",
	"judge",
	"critique",
	"stack-review",
	"stack-judge",
];

/**
 * Validate `input` against the schema for `stage`. On
 * success returns the count of items the schema cared
 * about (findings for council/judge, critiques for
 * critique). On failure returns each error as a path +
 * message row.
 */
export function validateOutput(
	stage: StageName,
	input: unknown,
): ValidateResult {
	if (!ALLOWED_STAGES.includes(stage)) {
		return {
			ok: false,
			errors: [
				{
					path: "",
					message: `unknown stage "${String(stage)}"; allowed: ${ALLOWED_STAGES.join(", ")}`,
					hint: "Use the exact stage name from your prompt.",
				},
			],
		};
	}

	const normalized = normalizeInput(stage, input);
	if (!normalized.ok) {
		return {
			ok: false,
			errors: [normalized.error],
			warnings: normalized.warnings,
		};
	}
	const candidate = normalized.value;

	const schema = getSchema(stage);
	if (!Value.Check(schema, candidate)) {
		const errors: ValidationError[] = [];
		for (const error of Value.Errors(schema, candidate)) {
			const path = error.instancePath;
			const value = valueAtPath(candidate, path);
			errors.push({
				path,
				message: explainError(error.message, value),
				hint: hintForError(path, value, candidate, stage),
			});
		}
		return { ok: false, errors, warnings: normalized.warnings };
	}

	const semanticErrors = validateNonBlankText(stage, candidate);
	if (semanticErrors.length > 0) {
		return { ok: false, errors: semanticErrors, warnings: normalized.warnings };
	}

	if (stage === "stack-review" || stage === "stack-judge") {
		const keyErrors = validatePerPrKeys(candidate);
		if (keyErrors.length > 0) {
			return { ok: false, errors: keyErrors, warnings: normalized.warnings };
		}
	}

	const count = itemCount(stage, candidate);
	return { ok: true, count, warnings: normalized.warnings };
}

type NormalizedInput =
	| {
			readonly ok: true;
			readonly value: unknown;
			readonly warnings?: readonly string[];
	  }
	| {
			readonly ok: false;
			readonly error: ValidationError;
			readonly warnings?: readonly string[];
	  };

function normalizeInput(stage: StageName, input: unknown): NormalizedInput {
	if (typeof input !== "string") return { ok: true, value: input };
	const trimmed = input.trim();
	const warning =
		"`output` was passed as a JSON string. I parsed it for this " +
		"validation attempt, but the next call should pass the object itself: " +
		`${expectedTopLevelHint(stage)} Do not wrap it in quotes.`;
	if (trimmed.length === 0) {
		return {
			ok: false,
			warnings: [warning],
			error: {
				path: "/output",
				message: "output is an empty string, not a JSON object",
				hint: "Pass the object you intend to emit, not a string wrapper.",
			},
		};
	}
	try {
		return { ok: true, value: JSON.parse(trimmed), warnings: [warning] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			warnings: [warning],
			error: {
				path: "/output",
				message: `output is a string and JSON.parse failed: ${message}`,
				hint:
					"Either pass the object directly to the tool, or fix the JSON string " +
					"escaping before trying again. Do not wrap the final object in quotes.",
			},
		};
	}
}

function explainError(message: string, input: unknown): string {
	return `${message}; received ${typeName(input)}`;
}

function hintForError(
	path: string,
	value: unknown,
	input: unknown,
	stage: StageName,
): string | undefined {
	if (path === "" && (typeof input !== "object" || input === null)) {
		return `Pass the top-level ${stage} output object itself, not prose, an array, null, or a JSON string.`;
	}
	if (path === "" && typeof input === "object" && input !== null) {
		return expectedTopLevelHint(stage);
	}
	if (value === undefined) {
		return "Add the required property at this path and verify again.";
	}
	return undefined;
}

function expectedTopLevelHint(stage: StageName): string {
	if (stage === "critique")
		return 'Expected top-level shape: { "critiques": [...] }.';
	if (stage === "stack-review" || stage === "stack-judge") {
		return 'Expected top-level shape: { "perPr": { "123": [...] }, "crossPr": [...] }.';
	}
	return 'Expected top-level shape: { "findings": [...] }.';
}

function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function valueAtPath(input: unknown, path: string): unknown {
	if (path === "") return input;
	let current = input;
	for (const rawPart of path.split("/").slice(1)) {
		const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
		if (Array.isArray(current)) {
			const index = Number(part);
			current = Number.isInteger(index) ? current[index] : undefined;
			continue;
		}
		if (typeof current === "object" && current !== null) {
			current = (current as Record<string, unknown>)[part];
			continue;
		}
		return undefined;
	}
	return current;
}

function validateNonBlankText(
	stage: StageName,
	input: unknown,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const record = input as {
		findings?: unknown[];
		critiques?: unknown[];
		perPr?: Record<string, unknown[]>;
		crossPr?: unknown[];
	};
	if (stage === "critique") {
		checkTextArray(errors, record.critiques ?? [], "/critiques", ["rationale"]);
		return errors;
	}
	if (stage === "stack-review" || stage === "stack-judge") {
		for (const [prNumber, findings] of Object.entries(record.perPr ?? {})) {
			checkTextArray(errors, findings, `/perPr/${prNumber}`, [
				"subject",
				"discussion",
			]);
		}
		checkTextArray(errors, record.crossPr ?? [], "/crossPr", [
			"subject",
			"discussion",
		]);
		return errors;
	}
	checkTextArray(errors, record.findings ?? [], "/findings", [
		"subject",
		"discussion",
	]);
	return errors;
}

function checkTextArray(
	errors: ValidationError[],
	items: unknown[],
	path: string,
	fields: readonly string[],
): void {
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		for (const field of fields) {
			if (typeof record[field] === "string" && record[field].trim() === "") {
				errors.push({
					path: `${path}/${index}/${field}`,
					message: "must contain non-whitespace text",
					hint: `Replace ${field} with a concrete explanation, not blanks.`,
				});
			}
		}
	}
}

function itemCount(stage: StageName, input: unknown): number {
	// The schema already passed, so `input` has the right
	// shape for `stage`. The narrow casts here mirror what
	// the schema enforced.
	const obj = input as {
		findings?: unknown[];
		critiques?: unknown[];
		perPr?: Record<string, unknown[]>;
		crossPr?: unknown[];
	};
	if (stage === "critique") {
		return obj.critiques?.length ?? 0;
	}
	if (stage === "stack-review" || stage === "stack-judge") {
		return perPrCount(obj.perPr) + (obj.crossPr?.length ?? 0);
	}
	return obj.findings?.length ?? 0;
}

function perPrCount(perPr: Record<string, unknown[]> | undefined): number {
	if (!perPr) return 0;
	return Object.values(perPr).reduce(
		(sum, findings) => sum + findings.length,
		0,
	);
}

function validatePerPrKeys(input: unknown): ValidationError[] {
	const obj = input as { perPr?: Record<string, unknown[]> };
	const perPr = obj.perPr ?? {};
	const errors: ValidationError[] = [];
	for (const key of Object.keys(perPr)) {
		if (!/^[1-9][0-9]*$/.test(key)) {
			errors.push({
				path: `/perPr/${key}`,
				message: "perPr keys must be PR numbers encoded as strings",
			});
		}
	}
	return errors;
}

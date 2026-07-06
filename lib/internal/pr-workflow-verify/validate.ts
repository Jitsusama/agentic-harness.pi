/**
 * Generic schema validator for reviewer-subagent outputs.
 *
 * Pure. Takes a `StageContract` (schema, item counter,
 * stage-specific semantic checks) and an arbitrary JSON-
 * shaped input, runs `Value.Check` against the schema and
 * surfaces the errors in a flat, easy-to-read shape.
 *
 * Used by the per-stage verify extensions in
 * `lib/internal/pr-workflow-verify/packs/{stage}.ts`. Anything that
 * mattered for "is this acceptable output?" lives here so
 * it stays testable without spinning up the extension
 * runtime.
 *
 * The helper functions (`checkTextArray`, `valueAtPath`,
 * etc.) are exported so per-stage extensions can compose
 * their semantic checks from the same primitives the schema
 * pass uses.
 */

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { normalizeFindingSeverities } from "../../../extensions/pr-workflow/severity-normalize.js";

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
			/**
			 * The normalized payload (JSON-string parsed, severities
			 * normalized) that passed the schema. The verify tool
			 * persists this out-of-band so the parent reads the object
			 * from a file rather than scraping it off the size-capped
			 * event stream.
			 */
			readonly value: unknown;
	  }
	| {
			readonly ok: false;
			readonly errors: ValidationError[];
			readonly warnings?: readonly string[];
	  };

/**
 * Per-stage validation contract. Each verify extension
 * declares one of these and passes it to `validateOutput`.
 *
 * The contract is the only thing that knows about the
 * stage's semantics: which schema, what shape the top
 * level should be, how to count items for the success
 * message, what semantic checks to run beyond the schema.
 */
export interface StageContract {
	/** Stage name returned through the tool result for the parent's mismatch check. */
	readonly stage: string;
	/** Top-level TypeBox schema for this stage's output. */
	readonly schema: TSchema;
	/** Human-readable hint about the expected top-level shape, used in error messages. */
	readonly topLevelHint: string;
	/** Count items in a valid payload (for the `ok: true` message). */
	readonly itemCount: (input: unknown) => number;
	/**
	 * Optional extra semantic checks beyond what the schema
	 * covers. Use `checkTextArray` and friends to compose.
	 */
	readonly semanticChecks?: (input: unknown) => readonly ValidationError[];
}

/**
 * Validate `input` against `contract`. On success returns
 * the stage's item count. On failure returns each problem
 * as a path + message row. JSON strings are parsed with a
 * warning so a subagent that misread the protocol can
 * recover on the next call.
 */
export function validateOutput(
	contract: StageContract,
	input: unknown,
): ValidateResult {
	const normalized = normalizeInput(contract, input);
	if (!normalized.ok) {
		return {
			ok: false,
			errors: [normalized.error],
			warnings: normalized.warnings,
		};
	}
	const severityResult = normalizeFindingSeverities(normalized.value);
	const candidate = severityResult.value;
	const warnings = mergeWarnings(normalized.warnings, severityResult.warnings);

	if (!Value.Check(contract.schema, candidate)) {
		const errors: ValidationError[] = [];
		for (const error of Value.Errors(contract.schema, candidate)) {
			const path = error.instancePath;
			const value = valueAtPath(candidate, path);
			errors.push({
				path,
				message: explainError(error.message, value),
				hint: hintForError(contract, path, value, candidate),
			});
		}
		return { ok: false, errors, warnings };
	}

	const semanticErrors = contract.semanticChecks?.(candidate) ?? [];
	if (semanticErrors.length > 0) {
		return {
			ok: false,
			errors: [...semanticErrors],
			warnings,
		};
	}

	const count = contract.itemCount(candidate);
	return { ok: true, count, warnings, value: candidate };
}

function mergeWarnings(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined,
): readonly string[] | undefined {
	const combined = [...(a ?? []), ...(b ?? [])];
	return combined.length > 0 ? combined : undefined;
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

function normalizeInput(
	contract: StageContract,
	input: unknown,
): NormalizedInput {
	if (typeof input !== "string") return { ok: true, value: input };
	const trimmed = input.trim();
	const warning =
		"`output` was passed as a JSON string. I parsed it for this " +
		"validation attempt, but the next call should pass the object itself: " +
		`${contract.topLevelHint} Do not wrap it in quotes.`;
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
					"Either pass the object directly to the tool, or fix the JSON " +
					"string escaping before trying again. Do not wrap the final " +
					"object in quotes.",
			},
		};
	}
}

function explainError(message: string, input: unknown): string {
	return `${message}; received ${typeName(input)}`;
}

function hintForError(
	contract: StageContract,
	path: string,
	value: unknown,
	input: unknown,
): string | undefined {
	if (path === "" && (typeof input !== "object" || input === null)) {
		return (
			`Pass the top-level ${contract.stage} output object itself, not prose, ` +
			"an array, null, or a JSON string."
		);
	}
	if (path === "" && typeof input === "object" && input !== null) {
		return contract.topLevelHint;
	}
	if (value === undefined) {
		return "Add the required property at this path and verify again.";
	}
	return undefined;
}

function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** Walk a JSON pointer into `input` and return whatever's there. */
export function valueAtPath(input: unknown, path: string): unknown {
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

/**
 * Add a "must contain non-whitespace text" error for every
 * blank value at `items[i].<field>` for the named fields.
 * The schema only checks types; this catches the common
 * model failure of emitting `""` where prose was required.
 */
export function checkTextArray(
	items: unknown[],
	pathPrefix: string,
	fields: readonly string[],
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		for (const field of fields) {
			const value = record[field];
			if (typeof value === "string" && value.trim() === "") {
				errors.push({
					path: `${pathPrefix}/${index}/${field}`,
					message: "must contain non-whitespace text",
					hint: `Replace ${field} with a concrete explanation, not blanks.`,
				});
			}
		}
	}
	return errors;
}

/**
 * Verify that every key of `record.perPr` looks like a PR
 * number (`/^[1-9][0-9]*$/`). Stack stages use this; non-
 * stack stages don't have a `perPr` field.
 */
export function checkPerPrKeys(input: unknown): ValidationError[] {
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

/**
 * For judge-style stages: when `selfSignal` is present and
 * has a string `rationale`, that rationale must contain
 * non-whitespace text. The schema allows the field to be
 * absent; if it's present, blanks are useless.
 */
export function checkJudgeSelfSignal(input: unknown): ValidationError[] {
	const record = input as { selfSignal?: unknown };
	const selfSignal = record.selfSignal;
	if (typeof selfSignal !== "object" || selfSignal === null) return [];
	const rationale = (selfSignal as Record<string, unknown>).rationale;
	if (typeof rationale !== "string" || rationale.trim() !== "") return [];
	return [
		{
			path: "/selfSignal/rationale",
			message: "must contain non-whitespace text",
			hint: "Replace rationale with a concrete confidence explanation, not blanks.",
		},
	];
}

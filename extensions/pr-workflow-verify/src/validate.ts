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
}

/** Result of validating one payload. */
export type ValidateResult =
	| { readonly ok: true; readonly count: number }
	| { readonly ok: false; readonly errors: ValidationError[] };

const ALLOWED_STAGES: ReadonlyArray<StageName> = [
	"council",
	"judge",
	"critique",
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
				},
			],
		};
	}

	const schema = getSchema(stage);
	if (!Value.Check(schema, input)) {
		const errors: ValidationError[] = [];
		for (const error of Value.Errors(schema, input)) {
			errors.push({ path: error.instancePath, message: error.message });
		}
		return { ok: false, errors };
	}

	const count = itemCount(stage, input);
	return { ok: true, count };
}

function itemCount(stage: StageName, input: unknown): number {
	// The schema already passed, so `input` has the right
	// shape for `stage`. The narrow casts here mirror what
	// the schema enforced.
	const obj = input as { findings?: unknown[]; critiques?: unknown[] };
	if (stage === "critique") {
		return obj.critiques?.length ?? 0;
	}
	return obj.findings?.length ?? 0;
}

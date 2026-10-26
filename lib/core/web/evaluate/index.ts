/**
 * Running an expression in the page, and reading back what it
 * said, including how it failed.
 */

export {
	describeThrow,
	type EvalFrame,
	type EvalOutcome,
	type EvalThrew,
	type EvalValue,
	MAX_INLINE_RESULT,
	type RawExceptionDetails,
	renderEvaluation,
} from "./outcome.ts";
export {
	evaluationSource,
	SERIALIZE_BREADTH,
	SERIALIZE_DEPTH,
	SERIALIZE_STRING,
} from "./probe.ts";

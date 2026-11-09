/**
 * Running an expression in the page, and reading back what it
 * said, including how it failed.
 */

export {
	describeThrow,
	type EvalFrame,
	type EvalOutcome,
	type EvalValue,
	renderEvaluation,
} from "./outcome.ts";
export { evaluationSource } from "./probe.ts";

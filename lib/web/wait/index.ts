/**
 * Waiting for the page to reach a state, and admitting it when
 * it does not.
 */

export {
	DEFAULT_QUIET_MS,
	inFlight,
	isIdle,
	renderWait,
	type WaitCondition,
	type WaitOutcome,
} from "./conditions.js";

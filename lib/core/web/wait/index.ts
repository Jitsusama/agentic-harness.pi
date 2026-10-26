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
} from "./conditions.ts";
export {
	SETTLE_BUDGET_MS,
	SETTLE_QUIET_MS,
	type Settled,
	settleSource,
} from "./settle.ts";

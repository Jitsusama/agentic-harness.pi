/**
 * The counters half of dead-horse detection: how many consecutive
 * verify failures a run has produced with no pass in between.
 *
 * "Dead-horse detection is counters plus the advisor's judgement." This
 * is only the first half. A run stuck on the same failure is a cheap,
 * deterministic signal; whether it is actually a dead horse rather
 * than a hard problem taking a while is a judgement call, the same
 * kind the advisor exists to make, and that half needs a live call
 * this does not make on its own.
 */
export interface DeadHorseState {
	readonly consecutiveFailures: number;
}

export const INITIAL_DEAD_HORSE: DeadHorseState = { consecutiveFailures: 0 };

/** Fold one verify outcome into the run of consecutive failures. */
export function observeVerify(
	state: DeadHorseState,
	outcome: { readonly passed: boolean },
): DeadHorseState {
	return {
		consecutiveFailures: outcome.passed ? 0 : state.consecutiveFailures + 1,
	};
}

/** Whether the consecutive-failure count has reached the threshold worth escalating at. */
export function isDeadHorse(state: DeadHorseState, threshold: number): boolean {
	return state.consecutiveFailures >= threshold;
}

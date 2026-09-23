/**
 * Logging propensity, which needs a real chance of not making the
 * deterministic choice to mean anything.
 *
 * Every logged policy in the real corpus was deterministic, so its
 * propensity was always 0 or 1, which is exactly the condition IPS and
 * doubly-robust estimation are undefined under: a replay cannot ask
 * "what would have happened under a different policy" when the logged
 * policy never did anything else. About five percent recorded
 * randomisation is the unlock this plan already settled on. This is
 * that mechanism, decision-agnostic: it does not know what it is
 * choosing between, only that it sometimes should not choose the
 * deterministic answer, and it always says what the odds of this exact
 * outcome were.
 */

export interface PropensityChoice<T> {
	/** What the deterministic policy would have picked. */
	readonly deterministic: T;
	/** What exploring could pick instead. */
	readonly alternatives: readonly T[];
	/** Chance of exploring rather than taking the deterministic choice. */
	readonly explorationRate: number;
	/** Injected for a reproducible test; real callers pass `Math.random`. */
	readonly random: () => number;
}

export interface PropensityResult<T> {
	readonly value: T;
	/** The probability this exact outcome had of being chosen. */
	readonly propensity: number;
	readonly explored: boolean;
}

/**
 * Choose the deterministic answer most of the time, and log an honest
 * propensity either way. With no alternatives to explore into, this
 * degrades to always the deterministic choice at propensity one, since
 * there is nothing to randomise toward.
 */
export function choseWithPropensity<T>(
	choice: PropensityChoice<T>,
): PropensityResult<T> {
	if (choice.alternatives.length === 0) {
		return { value: choice.deterministic, propensity: 1, explored: false };
	}
	if (choice.random() >= choice.explorationRate) {
		return {
			value: choice.deterministic,
			propensity: 1 - choice.explorationRate,
			explored: false,
		};
	}
	const index = Math.floor(choice.random() * choice.alternatives.length);
	return {
		value: choice.alternatives[index],
		propensity: choice.explorationRate / choice.alternatives.length,
		explored: true,
	};
}

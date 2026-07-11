/** Token counts for one run, split by channel. */
export interface RunTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

/**
 * Cost for one run in USD, split by channel. Sourced from pi's own
 * per-turn usage.cost, summed across every message_end turn of the
 * run, not from any external proxy.
 */
export interface RunCost {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

/** Verify gate outcome for one run. */
export type VerifyOutcome = "passed" | "failed" | "none";

/**
 * One subagent run recorded as first-class fields. The
 * parent session writes a record as each subagent finishes.
 */
export interface RunRecord {
	/** The fleet or council run this subagent belonged to. */
	readonly runId: string;
	/** The subagent's stable id within the run. */
	readonly subagentId: string;
	/** What produced the run (e.g. council, fleet). */
	readonly kind: string;
	/** Resolved model id, or empty when the session default was used. */
	readonly model: string;
	/** Persona or reviewer label. */
	readonly persona: string;
	/** Whether the verify gate passed, failed, or was not in play. */
	readonly verifyOutcome: VerifyOutcome;
	/** Verify retries taken before a valid result (0 when first try passed). */
	readonly retriesToValid: number;
	/** Number of warnings the run emitted. */
	readonly warningCount: number;
	/** Process exit code. */
	readonly exitCode: number;
	/** Token counts summed across the run's turns. */
	readonly tokens: RunTokens;
	/** Cost summed across the run's turns. */
	readonly cost: RunCost;
	/** When the run started, epoch milliseconds. */
	readonly startedAt: number;
}

/** Aggregate view of one run across its subagents. */
export interface RunSummary {
	readonly runId: string;
	readonly subagentCount: number;
	readonly passed: number;
	readonly failed: number;
	readonly totalRetries: number;
	readonly totalWarnings: number;
	readonly tokens: RunTokens;
	readonly cost: RunCost;
	/** cacheRead / (input + cacheRead); 0 when the denominator is 0. */
	readonly cacheReadRatio: number;
}

/**
 * A distilled weekly summary for one model and persona,
 * kept long after the raw rows it was rolled from age out.
 */
export interface RunRollup {
	/** Start of the week bucket, epoch milliseconds. */
	readonly weekStart: number;
	readonly model: string;
	readonly persona: string;
	readonly runCount: number;
	readonly totalRetries: number;
	readonly totalWarnings: number;
	readonly tokensTotal: number;
	readonly costTotal: number;
	/** cacheRead / (input + cacheRead) across the bucket; 0 when the denominator is 0. */
	readonly cacheReadRatio: number;
}

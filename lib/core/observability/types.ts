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
	/**
	 * Token counts summed across the run's turns, or null when the run
	 * reported no usage at all.
	 */
	readonly tokens: RunTokens | null;
	/**
	 * Cost summed across the run's turns, or null when the run reported
	 * no usage. Null is not zero: a run that died before it could report
	 * cost an unknown amount, and recording it as free makes it
	 * indistinguishable from one that genuinely cost nothing. Every one
	 * of the 75 zero-cost rows found in the real store had zero tokens
	 * too, so not one of them was actually free.
	 */
	readonly cost: RunCost | null;
	/** When the run started, epoch milliseconds. */
	readonly startedAt: number;
	/**
	 * The thinking level the run was launched at, or null when the
	 * launch did not name one and the level it inherited is not known.
	 * Required so a producer has to say, since a level left out reads
	 * the same as one nobody knew.
	 */
	readonly thinkingLevel: string | null;
	/**
	 * Every pi session the run's own processes announced, in order,
	 * which are the ids billing rows carry. Usually one; a stopped
	 * reviewer asked for its findings is a second process with a second
	 * session. Distinct from {@link sessionId}, the parent that
	 * dispatched the run. Empty when the run had no child process, as an
	 * in-process run does not; null when nobody knows.
	 */
	readonly subagentSessionIds: readonly string[] | null;
	/**
	 * The parent session that dispatched the run, the directory it was
	 * working in and the repo that directory belongs to. Stamped by the
	 * sink rather than the producer, since the sink is what knows where
	 * it is. Null when not known, never guessed: without these, $12,825
	 * of fan-out could not be traced to the work that caused it.
	 */
	readonly sessionId?: string | null;
	readonly cwd?: string | null;
	readonly repo?: string | null;
	/** When the run's record was written, epoch milliseconds. */
	readonly endedAt?: number | null;
}

/** Aggregate view of one run across its subagents. */
export interface RunSummary {
	readonly runId: string;
	readonly subagentCount: number;
	readonly passed: number;
	readonly failed: number;
	readonly totalRetries: number;
	readonly totalWarnings: number;
	/**
	 * Subagents that reported no usage. The totals beside this exclude
	 * them, so a total can say what it is missing rather than silently
	 * pricing the unknown at nothing.
	 */
	readonly unmetered: number;
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

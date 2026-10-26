import { processGlobal } from "../internal/process-global.ts";
import type { RunCost, RunRecord, RunTokens } from "./types.ts";

/** A sink that persists a run record. */
export type RunRecorder = (record: RunRecord) => void;

/**
 * Per-subagent result as a producer sees it. Both the fleet
 * dispatcher and the council runner expose usage,
 * verification, warnings and an exit code; this is the
 * subset {@link runRecordFrom} needs.
 */
export interface RunRecordInput {
	readonly runId: string;
	readonly subagentId: string;
	readonly kind: string;
	readonly model: string;
	readonly persona: string;
	/** The thinking level the run was launched at, null when unknown. */
	readonly thinkingLevel: string | null;
	readonly startedAt: number;
	readonly result: {
		readonly exitCode: number;
		/**
		 * The session ids the run's child processes announced, in order.
		 * Empty when there was no child process, null when not known.
		 */
		readonly sessionIds: readonly string[] | null;
		readonly warnings: readonly string[];
		readonly usage?: { readonly tokens: RunTokens; readonly cost: RunCost };
		readonly verification?: {
			readonly ok: boolean;
			/** Verify attempts observed; one means no retry. */
			readonly attempts?: number;
		};
	};
}

/**
 * Build a {@link RunRecord} from a producer's per-subagent
 * result. Verify outcome derives from the verification
 * block when present.
 *
 * A run that reported no usage (a crashed child, a round
 * killed before billing, an older pi) still produces a record,
 * because withholding the row would make the worst failures
 * the ones the table has nothing to say about. But its tokens
 * and cost are null rather than zero. The row is the claim
 * that the run happened; a zero would be a second claim, that
 * it was free, which nothing supports.
 */
export function runRecordFrom(input: RunRecordInput): RunRecord {
	const { result } = input;
	return {
		runId: input.runId,
		subagentId: input.subagentId,
		kind: input.kind,
		model: input.model,
		persona: input.persona,
		verifyOutcome:
			result.verification === undefined
				? "none"
				: result.verification.ok
					? "passed"
					: "failed",
		// Attempts beyond the first that were needed to reach the
		// recorded verify result. Zero when the first attempt was
		// the last, whether it passed or the reviewer never retried.
		retriesToValid: Math.max(0, (result.verification?.attempts ?? 1) - 1),
		warningCount: result.warnings.length,
		exitCode: result.exitCode,
		tokens: result.usage?.tokens ?? null,
		cost: result.usage?.cost ?? null,
		startedAt: input.startedAt,
		thinkingLevel: input.thinkingLevel,
		subagentSessionIds: result.sessionIds,
	};
}

// Process-global so a producer extension's recordRunEverywhere
// reaches the sink another extension registered; a module-level
// Set would give each extension its own, and records would never
// reach the writer.
const recorders = processGlobal(
	"pi:observability-recorders",
	() => new Set<RunRecorder>(),
);

/**
 * Register a sink for run records. Returns an unregister
 * function. The observability extension registers a writer
 * to its store; when nothing is registered, producers that
 * emit records are cheap no-ops.
 */
export function registerRunRecorder(recorder: RunRecorder): () => void {
	recorders.add(recorder);
	return () => {
		recorders.delete(recorder);
	};
}

/**
 * Emit a record to every registered sink. Producers call
 * this unconditionally; a throwing sink never disturbs the
 * run being recorded.
 */
export function recordRunEverywhere(record: RunRecord): void {
	for (const recorder of recorders) {
		try {
			recorder(record);
		} catch {
			// Telemetry is best-effort and must never fail a run.
		}
	}
}

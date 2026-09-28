/**
 * Fleet cancellation registry.
 *
 * pr-workflow has its own review-shaped cancellation
 * registry; the fleet wants the same lifecycle (begin a
 * run, register each active subprocess, abort one or all
 * on request) but with subagent-shaped labels and no
 * coupling to review operations.
 *
 * Copying instead of extracting a shared module is
 * deliberate: the two registries look alike today but
 * may diverge (pr-workflow wires retries and verify
 * stages, the fleet probably never will). When a third
 * consumer needs the same wiring we'll lift the registry
 * into the library.
 */

import type { SubagentSpec } from "../../lib/subagent/subagent.ts";

/** Error thrown when the user cancels a subagent subprocess. */
export class SubagentCancelledError extends Error {
	readonly subagentId: string;

	constructor(subagentId: string) {
		super(`Subagent "${subagentId}" was cancelled by user.`);
		this.name = "SubagentCancelledError";
		this.subagentId = subagentId;
	}
}

/** True when an error came from an explicit user cancellation. */
export function isSubagentCancelledError(
	error: unknown,
): error is SubagentCancelledError {
	return error instanceof SubagentCancelledError;
}

/** Result of a cancellation request. */
export type FleetCancellationOutcome =
	| {
			readonly ok: true;
			readonly mode: "one";
			readonly subagentId: string;
	  }
	| {
			readonly ok: true;
			readonly mode: "all";
			readonly count: number;
	  }
	| { readonly ok: false; readonly error: string };

/**
 * One fleet in flight: its own subagents and its own early requests.
 *
 * Per run, because pi runs a turn's tool calls side by side and job ids
 * are the caller's: two fleets up at once can both have an "alpha", and
 * a key pressed on one board must reach only that board's fleet.
 */
interface FleetRun {
	readonly key: string;
	readonly active: Map<string, RegisteredSubagent>;
	readonly cancelledIds: Set<string>;
	cancelAllRequested: boolean;
}

interface RegisteredSubagent {
	readonly run: FleetRun;
	readonly spec: SubagentSpec;
	readonly controller: AbortController;
	readonly startedAt: string;
	cancelledByUser: boolean;
}

/** Tracks in-flight subagent subprocesses and aborts them on request. */
export class FleetCancellationRegistry {
	/**
	 * The runs in flight under each key. A set, since a caller can name
	 * two runs alike, and a request for the name then reaches both rather
	 * than whichever began last.
	 */
	private readonly runs = new Map<string, Set<FleetRun>>();

	/** Start a cancellable fleet run, found again by `key`. */
	beginRun(key: string): FleetRunHandle {
		const run: FleetRun = {
			key,
			active: new Map(),
			cancelledIds: new Set(),
			cancelAllRequested: false,
		};
		const alike = this.runs.get(key) ?? new Set();
		alike.add(run);
		this.runs.set(key, alike);
		return {
			end: () => {
				alike.delete(run);
				if (alike.size === 0 && this.runs.get(key) === alike) {
					this.runs.delete(key);
				}
			},
			register: (spec, parentSignal) => this.register(run, spec, parentSignal),
		};
	}

	/**
	 * Cancel one subagent of the run under `key`, or every one of them
	 * when no id is given.
	 */
	cancel(key: string, subagentId?: string): FleetCancellationOutcome {
		const runs = [...(this.runs.get(key) ?? [])];
		if (subagentId) return this.cancelOne(runs, subagentId);
		return this.cancelAll(runs);
	}

	private register(
		run: FleetRun,
		spec: SubagentSpec,
		parentSignal: AbortSignal | undefined,
	): RegisteredFleetProcess {
		const controller = new AbortController();
		const entry: RegisteredSubagent = {
			run,
			spec,
			controller,
			startedAt: new Date().toISOString(),
			cancelledByUser: false,
		};
		run.active.set(spec.id, entry);
		const abortFromParent = (): void => controller.abort();
		if (parentSignal) {
			if (parentSignal.aborted) controller.abort();
			else
				parentSignal.addEventListener("abort", abortFromParent, { once: true });
		}
		if (run.cancelAllRequested || run.cancelledIds.has(spec.id)) {
			this.abortEntry(entry);
		}
		return {
			signal: controller.signal,
			wasCancelledByUser: () => entry.cancelledByUser,
			finish: () => {
				if (run.active.get(spec.id) === entry) run.active.delete(spec.id);
				parentSignal?.removeEventListener("abort", abortFromParent);
			},
		};
	}

	/**
	 * A subagent not yet registered is remembered rather than refused,
	 * since a board can show a row before the fleet reaches it.
	 */
	private cancelOne(
		runs: readonly FleetRun[],
		subagentId: string,
	): FleetCancellationOutcome {
		if (runs.length === 0) {
			return {
				ok: false,
				error: `No active subagent "${subagentId}" to cancel.`,
			};
		}
		for (const run of runs) {
			const entry = run.active.get(subagentId);
			if (entry) this.abortEntry(entry);
			else run.cancelledIds.add(subagentId);
		}
		return { ok: true, mode: "one", subagentId };
	}

	private cancelAll(runs: readonly FleetRun[]): FleetCancellationOutcome {
		if (runs.length === 0) {
			return { ok: false, error: "No active subagent subprocesses to cancel." };
		}
		let count = 0;
		for (const run of runs) {
			run.cancelAllRequested = true;
			for (const entry of run.active.values()) {
				this.abortEntry(entry);
				count++;
			}
		}
		return { ok: true, mode: "all", count };
	}

	private abortEntry(entry: RegisteredSubagent): void {
		entry.cancelledByUser = true;
		entry.controller.abort();
	}
}

/** A cancellable fleet run started by the registry. */
export interface FleetRunHandle {
	register(
		spec: SubagentSpec,
		parentSignal: AbortSignal | undefined,
	): RegisteredFleetProcess;
	end(): void;
}

/** Registration for one active subagent subprocess. */
export interface RegisteredFleetProcess {
	readonly signal: AbortSignal;
	wasCancelledByUser(): boolean;
	finish(): void;
}

/** Render a cancellation request result as tool output text. */
export function formatFleetCancellation(
	outcome: FleetCancellationOutcome,
): string {
	if (!outcome.ok) return outcome.error;
	if (outcome.mode === "one") {
		return `Cancellation requested for ${outcome.subagentId}.`;
	}
	const noun = outcome.count === 1 ? "subagent" : "subagents";
	return `Cancellation requested for ${outcome.count} active ${noun}.`;
}

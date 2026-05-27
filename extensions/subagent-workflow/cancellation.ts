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

import type { SubagentSpec } from "../../lib/subagent/subagent.js";

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

interface FleetRun {
	readonly id: number;
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
	private nextRunId = 1;
	private activeRun: FleetRun | null = null;
	private readonly active = new Map<string, RegisteredSubagent>();

	/** Start a cancellable fleet run. */
	beginRun(): FleetRunHandle {
		const run: FleetRun = {
			id: this.nextRunId++,
			cancelledIds: new Set(),
			cancelAllRequested: false,
		};
		this.activeRun = run;
		return {
			end: () => {
				if (this.activeRun?.id === run.id) this.activeRun = null;
			},
			register: (spec, parentSignal) => this.register(run, spec, parentSignal),
		};
	}

	/** Cancel one active subagent, or every active one when no id is given. */
	cancel(subagentId?: string): FleetCancellationOutcome {
		if (subagentId) return this.cancelOne(subagentId);
		return this.cancelAll();
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
		this.active.set(spec.id, entry);
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
				if (this.active.get(spec.id) === entry) this.active.delete(spec.id);
				parentSignal?.removeEventListener("abort", abortFromParent);
			},
		};
	}

	private cancelOne(subagentId: string): FleetCancellationOutcome {
		const entry = this.active.get(subagentId);
		if (entry) {
			this.abortEntry(entry);
			return { ok: true, mode: "one", subagentId };
		}
		if (this.activeRun) {
			this.activeRun.cancelledIds.add(subagentId);
			return { ok: true, mode: "one", subagentId };
		}
		return {
			ok: false,
			error: `No active subagent "${subagentId}" to cancel.`,
		};
	}

	private cancelAll(): FleetCancellationOutcome {
		if (this.activeRun) this.activeRun.cancelAllRequested = true;
		const active = Array.from(this.active.values());
		for (const entry of active) this.abortEntry(entry);
		if (active.length === 0 && this.activeRun === null) {
			return { ok: false, error: "No active subagent subprocesses to cancel." };
		}
		return { ok: true, mode: "all", count: active.length };
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

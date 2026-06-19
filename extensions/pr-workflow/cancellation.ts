import type { CouncilReviewer } from "../../lib/subagent/subagent.js";
import type { CouncilDispatch } from "./council.js";

/** Human-facing label for a cancellable reviewer run. */
export type ReviewOperation =
	| "council"
	| "council-retry"
	| "judge"
	| "review"
	| "critique"
	| "critique-retry"
	| "audit-threads";

/** Error thrown when the user cancels a reviewer subprocess. */
export class ReviewerCancelledError extends Error {
	readonly reviewerId: string;

	constructor(reviewerId: string) {
		super(`Reviewer "${reviewerId}" was cancelled by user.`);
		this.name = "ReviewerCancelledError";
		this.reviewerId = reviewerId;
	}
}

/** True when an error came from an explicit user cancellation. */
export function isReviewerCancelledError(
	error: unknown,
): error is ReviewerCancelledError {
	return error instanceof ReviewerCancelledError;
}

/** Snapshot of a reviewer subprocess that can still be cancelled. */
export interface ActiveReviewProcess {
	readonly reviewerId: string;
	readonly operation: ReviewOperation;
	readonly startedAt: string;
}

/** Result of a cancellation request. */
export type CancellationOutcome =
	| {
			readonly ok: true;
			readonly mode: "one";
			readonly reviewerId: string;
			readonly operation: ReviewOperation;
	  }
	| {
			readonly ok: true;
			readonly mode: "all";
			readonly count: number;
			readonly operation: ReviewOperation | null;
	  }
	| { readonly ok: false; readonly error: string };

interface ReviewRun {
	readonly id: number;
	readonly operation: ReviewOperation;
	readonly cancelledReviewerIds: Set<string>;
	cancelAllRequested: boolean;
}

interface RegisteredProcess {
	readonly run: ReviewRun;
	readonly reviewer: CouncilReviewer;
	readonly controller: AbortController;
	readonly startedAt: string;
	cancelledByUser: boolean;
}

/** Tracks in-flight reviewer subprocesses and aborts them on request. */
export class ReviewerCancellationRegistry {
	private nextRunId = 1;
	// Multiple review actions can be in flight at once (pi runs
	// sibling tool calls concurrently), so we track a set of
	// active runs in start order rather than a single slot that
	// the latest beginRun would clobber.
	private readonly activeRuns = new Set<ReviewRun>();
	private readonly active = new Map<string, RegisteredProcess>();
	// Resolvers for callers awaiting an idle registry. Drained
	// and cleared the moment the last active run ends.
	private readonly idleWaiters: Array<() => void> = [];

	/** Start a cancellable review action. */
	beginRun(operation: ReviewOperation): ReviewRunHandle {
		const run: ReviewRun = {
			id: this.nextRunId++,
			operation,
			cancelledReviewerIds: new Set(),
			cancelAllRequested: false,
		};
		this.activeRuns.add(run);
		return {
			operation,
			end: () => {
				this.activeRuns.delete(run);
				if (this.activeRuns.size === 0) this.resolveIdleWaiters();
			},
			register: (reviewer, parentSignal) =>
				this.register(run, reviewer, parentSignal),
		};
	}

	/**
	 * Resolve once no review run is active. Resolves on the
	 * spot when the registry is already idle, otherwise when
	 * the last in-flight run ends. Pair with `cancel()` to
	 * drain runs before releasing the resources they hold.
	 */
	whenIdle(): Promise<void> {
		if (this.activeRuns.size === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	private resolveIdleWaiters(): void {
		const waiters = this.idleWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	/** Cancel one active reviewer, or every active reviewer when no id is given. */
	cancel(reviewerId?: string): CancellationOutcome {
		if (reviewerId) return this.cancelOne(reviewerId);
		return this.cancelAll();
	}

	/** Current cancellable reviewer subprocesses. */
	listActive(): ActiveReviewProcess[] {
		return Array.from(this.active.values()).map((entry) => ({
			reviewerId: entry.reviewer.id,
			operation: entry.run.operation,
			startedAt: entry.startedAt,
		}));
	}

	/**
	 * The current review operation, if a cancellable action is
	 * running. When several overlap, reports the most recently
	 * started one — enough for the status line, which only
	 * needs a label to show.
	 */
	currentOperation(): ReviewOperation | null {
		return this.latestRun()?.operation ?? null;
	}

	/** The most recently started active run, or null when idle. */
	private latestRun(): ReviewRun | null {
		let latest: ReviewRun | null = null;
		for (const run of this.activeRuns) latest = run;
		return latest;
	}

	private register(
		run: ReviewRun,
		reviewer: CouncilReviewer,
		parentSignal: AbortSignal | undefined,
	): RegisteredReviewProcess {
		const controller = new AbortController();
		const entry: RegisteredProcess = {
			run,
			reviewer,
			controller,
			startedAt: new Date().toISOString(),
			cancelledByUser: false,
		};
		this.active.set(reviewer.id, entry);
		const abortFromParent = (): void => controller.abort();
		if (parentSignal) {
			if (parentSignal.aborted) controller.abort();
			else
				parentSignal.addEventListener("abort", abortFromParent, { once: true });
		}
		if (run.cancelAllRequested || run.cancelledReviewerIds.has(reviewer.id)) {
			this.abortEntry(entry);
		}
		return {
			signal: controller.signal,
			wasCancelledByUser: () => entry.cancelledByUser,
			finish: () => {
				if (this.active.get(reviewer.id) === entry)
					this.active.delete(reviewer.id);
				parentSignal?.removeEventListener("abort", abortFromParent);
			},
		};
	}

	private cancelOne(reviewerId: string): CancellationOutcome {
		const entry = this.active.get(reviewerId);
		if (entry) {
			this.abortEntry(entry);
			return {
				ok: true,
				mode: "one",
				reviewerId,
				operation: entry.run.operation,
			};
		}
		// Not yet registered: queue the cancellation on every
		// active run, since we can't know which one will spawn a
		// reviewer with this id. Whichever does aborts it on
		// registration; the others keep a harmless dead entry.
		const runs = Array.from(this.activeRuns);
		if (runs.length > 0) {
			for (const run of runs) run.cancelledReviewerIds.add(reviewerId);
			return {
				ok: true,
				mode: "one",
				reviewerId,
				operation: runs[runs.length - 1].operation,
			};
		}
		return {
			ok: false,
			error: `No active reviewer "${reviewerId}" to cancel.`,
		};
	}

	private cancelAll(): CancellationOutcome {
		for (const run of this.activeRuns) run.cancelAllRequested = true;
		const active = Array.from(this.active.values());
		for (const entry of active) this.abortEntry(entry);
		if (active.length === 0 && this.activeRuns.size === 0) {
			return { ok: false, error: "No active reviewer subprocesses to cancel." };
		}
		return {
			ok: true,
			mode: "all",
			count: active.length,
			operation: this.latestRun()?.operation ?? null,
		};
	}

	private abortEntry(entry: RegisteredProcess): void {
		entry.cancelledByUser = true;
		entry.controller.abort();
	}
}

/** A cancellable review action started by the registry. */
export interface ReviewRunHandle {
	readonly operation: ReviewOperation;
	register(
		reviewer: CouncilReviewer,
		parentSignal: AbortSignal | undefined,
	): RegisteredReviewProcess;
	end(): void;
}

/** Registration for one active reviewer subprocess. */
export interface RegisteredReviewProcess {
	readonly signal: AbortSignal;
	wasCancelledByUser(): boolean;
	finish(): void;
}

/** Wrap a reviewer dispatcher so the live progress panel can abort it. */
export function createCancellableDispatch(
	run: ReviewRunHandle,
	dispatch: CouncilDispatch,
): CouncilDispatch {
	return async (opts) => {
		const registration = run.register(opts.reviewer, opts.signal);
		try {
			const result = await dispatch({ ...opts, signal: registration.signal });
			if (registration.wasCancelledByUser()) {
				throw new ReviewerCancelledError(opts.reviewer.id);
			}
			return result;
		} catch (error) {
			if (registration.wasCancelledByUser()) {
				throw new ReviewerCancelledError(opts.reviewer.id);
			}
			throw error;
		} finally {
			registration.finish();
		}
	};
}

/** Render the cancellation request result for tool output. */
export function formatCancellationOutcome(
	outcome: CancellationOutcome,
): string {
	if (!outcome.ok) return outcome.error;
	if (outcome.mode === "one") {
		return `Cancellation requested for ${outcome.reviewerId} (${outcome.operation}).`;
	}
	const noun = outcome.count === 1 ? "reviewer" : "reviewers";
	const operation = outcome.operation ? ` during ${outcome.operation}` : "";
	return `Cancellation requested for ${outcome.count} active ${noun}${operation}.`;
}

/**
 * Waiting on CI as a background job.
 *
 * Without it a model waiting on checks either polls a turn at a time,
 * paying for each look, or runs `sleep` in a shell and holds the session
 * for as long as CI takes. Overnight, it does both. `review_see checks`
 * with `watch` hands the waiting to the job host instead: the call
 * returns at once, and the settled result arrives as a message of its
 * own.
 *
 * Only one watch per change at a time, so a model that asks twice does
 * not get told twice. A look that fails is not a settled result; a run
 * of failures in a row is, and says so, since a watch that can never
 * read anything should not sit there for two hours.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { withCallSignal } from "@jitsusama/agentic-harness.core/exec";
import type { ChecksRollup } from "@jitsusama/agentic-harness.core/review";
import { findJobHost, type Job } from "../../lib/jobs/index.ts";

/** How often to look. CI takes minutes; a tighter loop is cost with no reader. */
export const CHECKS_POLL_MS = 30_000;

/** How long to keep looking before saying the checks have not settled. */
export const CHECKS_WATCH_MS = 2 * 60 * 60 * 1000;

/** Looks in a row that may fail before the watch gives up. */
export const MAX_FAILED_LOOKS = 5;

/** Whether a rollup is still waiting on something. */
export function unsettled(rollup: ChecksRollup): boolean {
	return rollup.state === "pending" || rollup.state === "unreported";
}

/** What watching a change's checks needs. */
export interface ChecksWatch {
	readonly bus: EventBus;
	/** What identifies the change, so a second watch on it is refused. */
	readonly key: string;
	/** How the change is named to the model, e.g. `Shopify/app#7`. */
	readonly label: string;
	readonly read: () => Promise<ChecksRollup | null>;
	readonly render: (rollup: ChecksRollup) => string;
	readonly pollMs?: number;
	readonly watchMs?: number;
	readonly now?: () => number;
}

/** Why a watch could not be started. */
export type WatchRefusal = "no-host" | "already-watching";

const watching = new Set<string>();

/** Hold the waiting as a job, or say why it cannot be. */
export function watchChecks(watch: ChecksWatch): Job | WatchRefusal {
	if (watching.has(watch.key)) return "already-watching";
	const host = findJobHost(watch.bus);
	if (host === undefined) return "no-host";
	const job = host.start({ kind: "review", label: `checks on ${watch.label}` });
	watching.add(watch.key);
	const now = watch.now ?? Date.now;
	const started = now();

	// Outside the calling tool's signal, which ends when the call returns;
	// every later look would be cancelled by a call long finished.
	withCallSignal(undefined, () => {
		let looking = false;
		let failed = 0;
		const done = (summary: string, failure = false) => {
			clearInterval(timer);
			watching.delete(watch.key);
			job.finish({ summary, ...(failure ? { failed: true } : {}) });
		};
		const timer = setInterval(async () => {
			if (looking) return;
			looking = true;
			try {
				let rollup: ChecksRollup | null;
				try {
					rollup = await watch.read();
					failed = 0;
				} catch (error) {
					failed += 1;
					if (failed >= MAX_FAILED_LOOKS) {
						const why = error instanceof Error ? error.message : String(error);
						done(
							`Stopped watching checks on ${watch.label}: the last ${MAX_FAILED_LOOKS} looks failed (${why}). Read them again with review_see checks.`,
							true,
						);
					}
					return;
				}
				if (!rollup) {
					done(`Checks on ${watch.label} are no longer reported.`);
					return;
				}
				if (!unsettled(rollup)) {
					done(
						`Checks on ${watch.label} have settled: ${rollup.state}.\n${watch.render(rollup)}`,
					);
					return;
				}
				if (now() - started >= (watch.watchMs ?? CHECKS_WATCH_MS)) {
					done(
						`Checks on ${watch.label} were still ${rollup.state} after two hours of watching.\n${watch.render(rollup)}`,
					);
				}
			} finally {
				looking = false;
			}
		}, watch.pollMs ?? CHECKS_POLL_MS);
		timer.unref?.();

		job.signal.addEventListener(
			"abort",
			() => {
				clearInterval(timer);
				watching.delete(watch.key);
			},
			{ once: true },
		);
	});
	return job;
}

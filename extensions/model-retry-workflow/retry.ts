/**
 * The wait between a run that ended on a passing model failure and
 * the next try: when it starts, what the person sees while it runs,
 * and what ends it early.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	failedForAMoment,
	failureLine,
	MOST_TRIES,
	waitBefore,
} from "../../lib/internal/model-failure.ts";
import { whileCurrent } from "../../lib/internal/stale.ts";
import { findJobHost, type Job } from "../../lib/jobs/index.ts";
import { footerMark } from "../../lib/ui/footer-mark.ts";

/** The footer key the waiting mark is written under. */
const STATUS_KEY = "model-retry";

/** The kind of job a try is said through. */
const JOB_KIND = "model-retry";

const MS_PER_SECOND = 1000;

/** The retry state of one session, and what moves it. */
export interface Retrier {
	/** A run ended: its last reply, when it had one. */
	ended(reply: AssistantMessage | undefined): void;
	/** The run settled: wait and try again, or let it rest. */
	settled(aborted: boolean, ctx: ExtensionContext): void;
	/** Another run started, so its own settling decides. */
	started(): void;
	/** The person typed: whatever came before is theirs to judge. */
	typed(): void;
	/** The session is going away. */
	stop(): void;
}

/** A retrier sending its tries through `pi`. */
export function createRetrier(pi: ExtensionAPI): Retrier {
	let last: AssistantMessage | undefined;
	let tries = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let shown: ExtensionContext | undefined;
	let unsaid: Job | undefined;

	const stopWaiting = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (shown) whileCurrent(clearMark)(shown);
		shown = undefined;
		// A try not yet said would start a run on top of one already going.
		unsaid?.withdraw();
		unsaid = undefined;
	};

	// The try is said through job-workflow, the one thing that starts a
	// turn nobody typed, at a moment no run or prompt is under way.
	const tryAgain = (ctx: ExtensionContext, attempt: number, line: string) => {
		timer = undefined;
		clearMark(ctx);
		shown = undefined;
		const host = findJobHost(pi.events);
		if (!host) {
			ctx.ui.notify(
				"The model call cannot be tried again: job-workflow is not loaded.",
				"warning",
			);
			return;
		}
		const job = host.start({
			kind: JOB_KIND,
			label: "try the failed model call again",
		});
		unsaid = job;
		job.onDelivered(() => {
			if (unsaid === job) unsaid = undefined;
		});
		job.finish({ summary: retryText(attempt, line) });
	};

	return {
		ended(reply) {
			if (reply) last = reply;
		},
		settled(aborted, ctx) {
			const reply = last;
			last = undefined;
			stopWaiting();
			if (aborted || !reply) {
				tries = 0;
				return;
			}
			if (!failedForAMoment(reply, ctx.model?.contextWindow ?? 0)) {
				tries = 0;
				return;
			}
			const attempt = tries + 1;
			const wait = waitBefore(attempt);
			const line = failureLine(reply);
			if (wait === undefined) {
				tries = 0;
				ctx.ui.notify(
					`The model call still fails after ${MOST_TRIES} more tries: ${line}. Type to try again.`,
					"error",
				);
				return;
			}
			tries = attempt;
			shown = ctx;
			ctx.ui.setStatus(
				STATUS_KEY,
				footerMark("retrying", "warning", ctx.ui.theme, attempt),
			);
			ctx.ui.notify(
				`The model call failed: ${line}. Trying again in ${Math.round(wait / MS_PER_SECOND)} s (${attempt} of ${MOST_TRIES}).`,
				"warning",
			);
			timer = setTimeout(
				whileCurrent(() => tryAgain(ctx, attempt, line)),
				wait,
			);
			timer.unref?.();
		},
		started() {
			stopWaiting();
		},
		typed() {
			stopWaiting();
			tries = 0;
		},
		stop() {
			stopWaiting();
		},
	};
}

/** What the model reads as the try begins. */
function retryText(attempt: number, line: string): string {
	return `The last model call failed (${line}) after pi's own retries. The harness waited and is trying again (${attempt} of ${MOST_TRIES}): carry on from where you left off.`;
}

function clearMark(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

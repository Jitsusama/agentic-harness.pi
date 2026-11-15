/**
 * When a warm browser is idle enough to close, and the countdown
 * that closes it.
 *
 * Kept apart from the shared browser because these are decisions
 * over counts and timers, with the timers injectable, so the policy
 * can be tested and changed without a Chrome.
 */

import { clearTimeout, setTimeout } from "node:timers";

/**
 * Puppeteer opens one blank page on launch, so a browser with no
 * consumer page open sits at this count. A higher count means work
 * is in flight.
 */
const INITIAL_PAGE_COUNT = 1;

/** Decide whether an idle browser is truly unused and safe to close. */
export function shouldCloseWhenIdle(openPageCount: number): boolean {
	return openPageCount <= INITIAL_PAGE_COUNT;
}

/**
 * Decide whether teardown should force-kill the browser process group.
 * Never after a clean graceful close, since the pid is already gone and
 * could be reused; only when the close did not happen and the process
 * still verifies as our Chrome.
 */
export function shouldForceKill(
	closedGracefully: boolean,
	stillVerifies: boolean,
): boolean {
	return !closedGracefully && stillVerifies;
}

/** A countdown that closes an idle browser and rearms on use. */
export interface IdleCloser {
	touch(): void;
	cancel(): void;
}

/** Inputs for the idle-close countdown; timers are injectable for tests. */
export interface IdleCloserOptions {
	idleMs: number;
	close: () => void;
	setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
	clearTimer?: (id: NodeJS.Timeout) => void;
}

/** Build an idle-close countdown that rearms on touch and stops on cancel. */
export function createIdleCloser(opts: IdleCloserOptions): IdleCloser {
	const setTimer: (fn: () => void, ms: number) => NodeJS.Timeout =
		opts.setTimer ?? setTimeout;
	const clearTimer = opts.clearTimer ?? clearTimeout;
	let timer: NodeJS.Timeout | undefined;
	const cancel = () => {
		if (timer !== undefined) {
			clearTimer(timer);
			timer = undefined;
		}
	};
	return {
		touch() {
			cancel();
			timer = setTimer(() => {
				timer = undefined;
				opts.close();
			}, opts.idleMs);
			// A pending idle close must not, by itself, hold the event loop
			// open and delay process exit.
			(timer as { unref?: () => void }).unref?.();
		},
		cancel,
	};
}

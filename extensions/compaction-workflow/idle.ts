/**
 * A timer that runs once a session has been idle for a while, and is
 * called off by anything that ends the idleness.
 *
 * Started when a run ends and cancelled when the next one starts or
 * the session goes, so what it runs sees the session exactly as the
 * idle user left it. It holds the process open for nothing: an unref'd
 * timer lets pi exit while it waits.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface IdleTimer {
	/** Wait out the idle period for this session, replacing any wait under way. */
	start(ctx: ExtensionContext): void;
	/** Stop waiting. */
	cancel(): void;
}

/** A timer that calls `onIdle` after `delayMs` of idleness. */
export function idleTimer(
	onIdle: (ctx: ExtensionContext) => void,
	delayMs: number,
): IdleTimer {
	let pending: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => {
		if (pending !== undefined) clearTimeout(pending);
		pending = undefined;
	};
	return {
		cancel,
		start(ctx) {
			cancel();
			pending = setTimeout(() => {
				pending = undefined;
				onIdle(ctx);
			}, delayMs);
			pending.unref?.();
		},
	};
}

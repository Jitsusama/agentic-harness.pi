/**
 * How every panel goes onto the screen and comes off it again.
 *
 * Three things go wrong when a panel is mounted with `ctx.ui.custom`
 * directly, and each primitive used to be exposed to all of them:
 *
 * - Two panels asked for at once both mount. The gate queue settles
 *   that, and every panel waits its turn here.
 * - Pi's close for an overlay hides whichever overlay is on top, not
 *   its own. A panel answered while another overlay sits above it takes
 *   that one down and stays up itself, answered and unlistened to. So a
 *   panel here comes off by its own overlay handle.
 * - A panel on screen when its turn is stopped stayed up until a key
 *   was pressed. Here it closes and answers as Escape would, so a gate
 *   fails closed.
 *
 * Pi's close is still what settles its promise and disposes the panel,
 * and it is called whenever that is safe: once our own overlay is gone,
 * its topmost pop has nothing left to take. With another overlay still
 * up, this settles and disposes instead, and pi's promise is left
 * unsettled rather than let it hide somebody else's panel.
 */

import type {
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { runGate } from "./gate-queue.ts";
import { OVERLAID } from "./overlay.ts";

/** A disposable panel, as pi's factories return one. */
type Panel = Component & { dispose?(): void };

/** What pi's `ctx.ui.custom` builds a panel from. */
export type PanelFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => Panel | Promise<Panel>;

/** How a panel is mounted, and what it answers when it is not. */
export interface MountOptions<T> {
	/**
	 * The answer Escape gives. Returned when the panel is stopped, on
	 * screen or waiting for it, so a gate fails closed.
	 */
	cancelled: T;
	/** A second reason to close, for a panel its caller can dismiss. */
	dismiss?: AbortSignal;
	/** Runs once the panel has the screen, before it is shown. */
	onShow?: () => void;
	/** Runs once the panel is gone, whichever way it went. */
	onGone?: () => void;
}

/**
 * Mount a panel once the screen is free, and take it down by its own
 * handle when it answers or its turn is stopped.
 *
 * The turn's signal is read now, as the call is made: a gate belongs to
 * the turn that raised it, not whichever is running when its turn in the
 * queue comes.
 */
export async function mountPanel<T>(
	ctx: ExtensionContext,
	factory: PanelFactory<T>,
	options: MountOptions<T>,
): Promise<T> {
	const signal = either(ctx.signal, options.dismiss);
	try {
		return await runGate(
			async () => {
				options.onShow?.();
				try {
					return await showUntilGone(ctx, factory, options.cancelled, signal);
				} finally {
					options.onGone?.();
				}
			},
			{ signal },
		);
	} catch (error) {
		if (signal?.aborted && isAbortError(error)) return options.cancelled;
		throw error;
	}
}

function showUntilGone<T>(
	ctx: ExtensionContext,
	factory: PanelFactory<T>,
	cancelled: T,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (signal?.aborted) return Promise.resolve(cancelled);

	return new Promise<T>((resolve, reject) => {
		let tui: TUI | undefined;
		let piClose: ((result: T) => void) | undefined;
		let panel: Panel | undefined;
		let handle: OverlayHandle | undefined;
		// Set once this panel has answered, by a key, a stop or a dismiss.
		// Pi's own promise may settle later or never; ours settles here.
		let answer: { value: T } | undefined;

		const takeDown = (value: T): void => {
			// Pi shows the overlay only after the factory's promise
			// settles; answered before that, it comes down as it arrives.
			if (!handle) return;
			handle.hide();
			if (tui && overlaysLeft(tui) === false && piClose) {
				piClose(value);
				return;
			}
			try {
				panel?.dispose?.();
			} catch {
				// Pi ignores a throwing dispose on its own close as well; the
				// panel is already off the screen, which is what matters.
			}
		};

		const close = (value: T): void => {
			if (answer) return;
			answer = { value };
			signal?.removeEventListener("abort", stop);
			takeDown(value);
			resolve(value);
		};
		const stop = (): void => close(cancelled);
		signal?.addEventListener("abort", stop, { once: true });

		ctx.ui
			.custom<T>(
				(t, theme, keybindings, done) => {
					tui = t;
					piClose = done;
					const made = factory(t, theme, keybindings, close);
					if (made instanceof Promise) {
						return made.then((p) => {
							panel = p;
							return p;
						});
					}
					panel = made;
					return made;
				},
				{
					...OVERLAID,
					onHandle: (h) => {
						handle = h;
						if (answer) takeDown(answer.value);
					},
				},
			)
			.then(
				(value) => close(value),
				(error: unknown) => {
					if (answer) return;
					answer = { value: cancelled };
					signal?.removeEventListener("abort", stop);
					reject(error);
				},
			);
	});
}

/**
 * Whether any overlay is still on the stack, hidden ones included, since
 * pi's close pops a hidden one as readily as a shown one. Pi's `TUI`
 * interface does not declare it; its screen classes do. Undefined when
 * the screen cannot say, which leaves pi's close uncalled: a promise
 * that never settles costs a closure, a wrong pop costs somebody's panel.
 */
export function overlaysLeft(tui: TUI): boolean | undefined {
	const entries: unknown = Reflect.get(tui, "hasOverlayEntries");
	return typeof entries === "boolean" ? entries : undefined;
}

function either(
	a: AbortSignal | undefined,
	b: AbortSignal | undefined,
): AbortSignal | undefined {
	if (a && b) return AbortSignal.any([a, b]);
	return a ?? b;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

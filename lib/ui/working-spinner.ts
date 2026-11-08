/**
 * pi's working spinner, turning only while its window has focus.
 *
 * A still indicator is one frame, which pi draws once and never times;
 * the default, restored on focus, is pi's own animation.
 */

import type { WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { focusReport, isMouseReport, isPress } from "./terminal-reports.ts";

/** The mark shown in place of the spinner while the window lacks focus. */
export const STILL_MARK = "●";

/** The part of pi's UI the spinner is set through. */
export interface SpinnerUI {
	onTerminalInput(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void;
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;
	readonly theme: { fg(color: "accent", text: string): string };
}

/**
 * Whether `data` says the window has focus (true), lost it (false), or
 * neither. A key or a click reaches only the focused window; the pointer
 * passing over, or a scroll, reaches any window under it.
 */
export function focusFrom(data: string): boolean | undefined {
	const report = focusReport(data);
	if (report !== undefined) return report === "in";
	if (isMouseReport(data)) return isPress(data) ? true : undefined;
	return true;
}

/**
 * Shows the still mark at once, the spinner whenever the window gains
 * focus and the mark again when it loses it. Input passes through
 * untouched. Returns the call that stops, which puts pi's spinner back.
 */
export function stillWhereUnfocused(ui: SpinnerUI): () => void {
	let focused: boolean | undefined;
	const show = (now: boolean) => {
		if (now === focused) return;
		focused = now;
		try {
			ui.setWorkingIndicator(
				now ? undefined : { frames: [ui.theme.fg("accent", STILL_MARK)] },
			);
		} catch {
			// A context gone stale in a reload has no indicator to set.
		}
	};
	show(false);
	const unlisten = ui.onTerminalInput((data) => {
		const now = focusFrom(data);
		if (now !== undefined) show(now);
		return undefined;
	});
	return () => {
		unlisten();
		show(true);
	};
}

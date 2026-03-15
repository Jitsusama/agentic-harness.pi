/**
 * Shared layout helpers for prompt variants.
 *
 * Both prompt-single and prompt-tabbed use these to compute
 * chrome height and render the keyboard hint bar.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Action, Option } from "./types.js";

/**
 * Compute total chrome lines for the panel (borders, tabs,
 * actions, options, hints) to calculate the content budget.
 */
export function computeChromeLines(
	hasTabs: boolean,
	actions: Action[] | undefined,
	options: Option[] | undefined,
): number {
	let lines = 2; // top + bottom border
	if (hasTabs) lines += 2; // tab strip + separator
	if (actions) lines += 2; // blank + action bar
	if (options) lines += 2 + (options.length > 0 ? options.length : 0); // blank + options
	lines += 2; // blank + hint bar
	return lines;
}

/** Build the hint bar as a styled string. */
export function buildHintBar(opts: {
	theme: Theme;
	hasTabs: boolean;
	needsVScroll: boolean;
	needsHScroll: boolean;
	hasActions: boolean;
	isUserTab?: boolean;
	allComplete?: boolean;
}): string {
	const { theme } = opts;
	const hints: string[] = [];
	if (opts.hasTabs) {
		hints.push(theme.fg("dim", "Tab navigate"));
		hints.push(theme.fg("dim", "Ctrl+# jump"));
		const submit = "Ctrl+Enter submit";
		hints.push(
			opts.allComplete ? theme.fg("accent", submit) : theme.fg("dim", submit),
		);
	}
	if (opts.isUserTab) {
		hints.push(theme.fg("dim", "↑↓ select"));
	} else if (!opts.hasActions) {
		hints.push(theme.fg("dim", "↑↓ select"));
		hints.push(theme.fg("dim", "Enter confirm"));
	}
	hints.push(theme.fg("dim", "Esc cancel"));
	if (opts.needsVScroll) hints.push(theme.fg("dim", "Shift+↑↓ scroll"));
	if (opts.needsHScroll) hints.push(theme.fg("dim", "Shift+←→ pan"));
	return ` ${hints.join(theme.fg("dim", " · "))}`;
}

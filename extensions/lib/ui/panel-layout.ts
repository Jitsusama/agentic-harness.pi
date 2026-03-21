/**
 * Shared layout helpers for prompt variants.
 *
 * Both prompt-single and prompt-tabbed use these to compute
 * chrome height and render the keyboard hint bar.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Action, Option, PromptView } from "./types.js";

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

/** Options for building the hint bar. */
export interface HintBarOptions {
	theme: Theme;
	hasTabs: boolean;
	needsVScroll: boolean;
	needsHScroll: boolean;
	hasActions: boolean;
	isUserTab?: boolean;
	allComplete?: boolean;
	/** Views for the current tab. Omit or empty for no view hints. */
	views?: PromptView[];
	/** Index of the currently active view. */
	activeViewIndex?: number;
}

/** Build the hint bar as a styled string. */
export function buildHintBar(opts: HintBarOptions): string {
	const { theme } = opts;
	const hints: string[] = [];

	// These are the view hints in [K]eyword format, with the active view highlighted.
	const views = opts.views ?? [];
	if (views.length > 1) {
		const activeIdx = opts.activeViewIndex ?? 0;
		for (let i = 0; i < views.length; i++) {
			const view = views[i];
			if (!view) continue;
			const isActive = i === activeIdx;
			hints.push(formatViewHint(view.key, view.label, theme, isActive));
		}
	}

	// These are the navigation hints.
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
	if (opts.needsVScroll) {
		hints.push(theme.fg("dim", "Shift+↑↓ scroll"));
		hints.push(theme.fg("dim", "Fn+↑↓ half-page"));
	}
	if (opts.needsHScroll) hints.push(theme.fg("dim", "Shift+←→ pan"));
	return ` ${hints.join(theme.fg("dim", " · "))}`;
}

/**
 * Format a view key-hint: [K]eyword with the key letter highlighted.
 * Active view uses accent for the full label; inactive uses dim.
 */
function formatViewHint(
	key: string,
	label: string,
	theme: Theme,
	isActive: boolean,
): string {
	const upperKey = key.toUpperCase();
	const idx = label.toUpperCase().indexOf(upperKey);
	const color = isActive ? "accent" : "dim";

	if (idx >= 0) {
		const before = label.slice(0, idx);
		const keyChar = label.slice(idx, idx + 1);
		const after = label.slice(idx + 1);
		return `${theme.fg(color, before)}[${theme.fg("accent", keyChar)}]${theme.fg(color, after)}`;
	}

	return `[${theme.fg("accent", upperKey)}] ${theme.fg(color, label)}`;
}

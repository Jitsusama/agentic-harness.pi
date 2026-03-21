/**
 * Shared layout helpers for prompt variants.
 *
 * Provides chrome height computation and the unified footer
 * that all prompt types share.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Action, Option, PromptView } from "./types.js";

/**
 * Compute total chrome lines for the panel (borders, tabs,
 * options, footer) to calculate the content budget.
 */
export function computeChromeLines(
	hasTabs: boolean,
	actions: Action[] | undefined,
	options: Option[] | undefined,
): number {
	let lines = 2; // top + bottom border
	if (hasTabs) lines += 2; // tab strip + separator
	if (options) lines += 2 + (options.length > 0 ? options.length : 0); // blank + options
	lines += 1; // blank before footer
	lines += actions ? 2 : 1; // footer: 2 rows with actions, 1 without
	return lines;
}

/** Options for the unified footer. */
export interface FooterOptions {
	theme: Theme;
	width: number;
	actions?: Action[];
	views?: PromptView[];
	activeViewIndex?: number;
	hasTabs?: boolean;
	allComplete?: boolean;
	isUserTab?: boolean;
	showRedirectHint?: boolean;
	needsVScroll?: boolean;
	needsHScroll?: boolean;
}

/**
 * Render the unified footer: a two-row grid when actions are
 * present, or a single row when they're not.
 *
 * Row 1 (actions): [A]pprove  [R]eject  [P]ass   ⇧+key annotate · ⇧+Esc redirect
 * Row 2 (controls): [1] Overview  [2] Source · Tab · C+#   Enter · C+Enter submit · Esc cancel
 */
export function renderFooter(opts: FooterOptions): string[] {
	const { theme, width, actions } = opts;
	const lines: string[] = [];

	if (actions && actions.length > 0) {
		lines.push(renderActionRow(actions, width, theme, opts.showRedirectHint));
	}

	lines.push(renderControlRow(opts));
	return lines;
}

/** Row 1: actions (left) + modifiers (right). */
function renderActionRow(
	actions: Action[],
	width: number,
	theme: Theme,
	showRedirectHint?: boolean,
): string {
	const parts: string[] = [];
	for (const action of actions) {
		parts.push(formatActionLabel(action, theme));
	}
	const left = ` ${parts.join("  ")}`;

	if (showRedirectHint === false) {
		return truncateToWidth(left, width);
	}

	const right = theme.fg("dim", "⇧+key annotate · ⇧+Esc redirect");
	return padLeftRight(left, right, width);
}

/** Row 2: navigation (left) + decisions (right). */
function renderControlRow(opts: FooterOptions): string {
	const { theme, width } = opts;
	const leftParts: string[] = [];
	const rightParts: string[] = [];

	// Left: view hints + tab hints
	const views = opts.views ?? [];
	if (views.length > 1) {
		const activeIdx = opts.activeViewIndex ?? 0;
		const viewHints: string[] = [];
		for (let i = 0; i < views.length; i++) {
			const view = views[i];
			if (!view) continue;
			const isActive = i === activeIdx;
			viewHints.push(formatViewHint(view.key, view.label, theme, isActive));
		}
		leftParts.push(viewHints.join("  "));
	}

	if (opts.hasTabs) {
		leftParts.push(theme.fg("dim", "Tab"));
		leftParts.push(theme.fg("dim", "Ctrl+#"));
	}

	if (opts.isUserTab) {
		leftParts.push(theme.fg("dim", "↑↓ select"));
	} else if (!opts.actions || opts.actions.length === 0) {
		leftParts.push(theme.fg("dim", "↑↓ select"));
		rightParts.push(theme.fg("dim", "Enter confirm"));
	}

	// Right: decisions
	if (opts.hasTabs) {
		const submit = "Ctrl+Enter submit";
		rightParts.push(
			opts.allComplete ? theme.fg("accent", submit) : theme.fg("dim", submit),
		);
	}
	rightParts.push(theme.fg("dim", "Esc cancel"));

	const sep = theme.fg("dim", " · ");
	const left = leftParts.length > 0 ? ` ${leftParts.join(sep)}` : "";
	const right = rightParts.join(sep);

	return padLeftRight(left, right, width);
}

/**
 * Pad between left and right content to fill the width.
 * If the combined content exceeds width, truncates.
 */
function padLeftRight(left: string, right: string, width: number): string {
	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);
	const gap = width - leftW - rightW;

	if (gap <= 0) {
		return truncateToWidth(`${left}  ${right}`, width);
	}

	return `${left}${" ".repeat(gap)}${right}`;
}

/** Format an action label with the key letter highlighted in accent. */
function formatActionLabel(action: Action, theme: Theme): string {
	const label = action.label;
	const key = action.key;
	const upperKey = key.toUpperCase();
	const idx = label.toUpperCase().indexOf(upperKey);

	if (idx >= 0) {
		const before = label.slice(0, idx);
		const keyChar = label.slice(idx, idx + 1);
		const after = label.slice(idx + 1);
		return `${before}[${theme.fg("accent", keyChar)}]${after}`;
	}

	return `[${theme.fg("accent", upperKey)}] ${label}`;
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

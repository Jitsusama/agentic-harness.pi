/**
 * OptionList: numbered vertical option list with cursor and
 * on-select descriptions.
 *
 * Descriptions are shown only for the currently selected item
 * (in dim colour): progressive disclosure to save vertical space.
 * Number keys provide direct selection.
 *
 *     1. Big bang: rewrite all extensions
 *   ▸ 2. Incremental: replace layers gradually
 *        Start with lowest layer, work up.        ← dim
 *     3. By extension: port one at a time
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { GLYPH, type ListChoice } from "./types.js";

/** Result of navigating and selecting from an option list. */
export type OptionListResult =
	| { type: "select"; index: number }
	| { type: "cancel" };

/** Resolve the value for an option (defaults to lowercase label). */
export function optionValue(option: ListChoice): string {
	return option.value ?? option.label.toLowerCase();
}

/** Render the option list with cursor and on-select description. */
export function renderOptionList(
	options: ListChoice[],
	selectedIndex: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	for (let i = 0; i < options.length; i++) {
		const opt = options[i];
		if (!opt) continue;

		const isSelected = i === selectedIndex;
		const prefix = isSelected ? ` ${theme.fg("accent", GLYPH.cursor)} ` : "   ";
		const number = `${i + 1}. `;
		const label = opt.label;

		if (isSelected) {
			lines.push(`${prefix}${theme.fg("accent", `${number}${label}`)}`);
		} else {
			lines.push(`${prefix}${number}${label}`);
		}

		// We only show the description for the currently selected item.
		if (isSelected && opt.description) {
			// The prefix has ANSI codes, so we use a fixed visible width (3 chars) + the number.
			const indent = " ".repeat(3 + number.length);
			lines.push(`${indent}${theme.fg("dim", opt.description)}`);
		}
	}

	return lines;
}

/**
 * Handle option list key input. Returns a result or null if
 * unhandled. The caller maintains selectedIndex state.
 */
export function handleOptionInput(
	data: string,
	selectedIndex: number,
	optionCount: number,
): { type: "navigate"; index: number } | OptionListResult | null {
	// Arrow key navigation
	if (matchesKey(data, Key.up)) {
		return {
			type: "navigate",
			index: Math.max(0, selectedIndex - 1),
		};
	}
	if (matchesKey(data, Key.down)) {
		return {
			type: "navigate",
			index: Math.min(optionCount - 1, selectedIndex + 1),
		};
	}

	// Number key direct selection (1-9)
	const num = Number.parseInt(data, 10);
	if (num >= 1 && num <= optionCount && num <= 9) {
		return { type: "select", index: num - 1 };
	}

	// Enter confirms current selection
	if (matchesKey(data, Key.enter)) {
		return { type: "select", index: selectedIndex };
	}

	// Escape cancels
	if (matchesKey(data, Key.escape)) {
		return { type: "cancel" };
	}

	return null;
}

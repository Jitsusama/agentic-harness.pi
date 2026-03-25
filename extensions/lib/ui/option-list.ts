/**
 * OptionList: numbered vertical option list with cursor and
 * on-select descriptions.
 *
 * Composes on NavigableList for cursor rendering, accent
 * highlighting and expand/collapse. Adds number prefixes,
 * number-key direct selection, Enter to confirm and Escape
 * to cancel.
 *
 *   ▸ 1. Incremental: replace layers gradually
 *        Start with lowest layer, work up.        ← dim
 *     2. Big bang: rewrite all extensions
 *     3. By extension: port one at a time
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import {
	handleNavigableListInput,
	type NavigableItem,
	renderNavigableList,
} from "./navigable-list.js";
import type { ListChoice } from "./types.js";

/** Result of navigating and selecting from an option list. */
export type OptionListResult =
	| { type: "select"; index: number }
	| { type: "cancel" };

/** Resolve the value for an option (defaults to lowercase label). */
export function optionValue(option: ListChoice): string {
	return option.value ?? option.label.toLowerCase();
}

/** Map a ListChoice to a NavigableItem for the shared renderer. */
function toNavigableItem(opt: ListChoice): NavigableItem {
	return {
		summary: opt.label,
		detail: opt.description
			? [{ text: opt.description, color: "dim" }]
			: undefined,
	};
}

/** Render the option list with cursor and on-select description. */
export function renderOptionList(
	options: ListChoice[],
	selectedIndex: number,
	theme: Theme,
): string[] {
	const items = options.map((opt) => toNavigableItem(opt));
	const { lines } = renderNavigableList(items, selectedIndex, theme, {
		numbered: true,
	});
	return lines;
}

/**
 * Handle option list key input. Returns a result or null if
 * unhandled. The caller maintains selectedIndex state.
 *
 * Composes NavigableList's ↑/↓ handling (wrapping) with
 * number-key direct selection, Enter to confirm and Escape
 * to cancel.
 */
export function handleOptionInput(
	data: string,
	selectedIndex: number,
	optionCount: number,
): { type: "navigate"; index: number } | OptionListResult | null {
	// ↑/↓ navigation (wrapping, from shared handler)
	const navResult = handleNavigableListInput(data, selectedIndex, optionCount);
	if (navResult !== null) {
		return { type: "navigate", index: navResult };
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

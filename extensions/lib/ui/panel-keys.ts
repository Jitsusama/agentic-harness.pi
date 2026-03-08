/**
 * Panel key handling — input processors for scroll, option
 * navigation, and selection confirmation.
 *
 * Each function returns a result or null if the key wasn't
 * handled. The caller (showPanel/showPanelSeries) interprets
 * the result and updates its own state.
 */

import { Key, matchesKey } from "@mariozechner/pi-tui";
import { H_SCROLL_STEP } from "./panel-state.js";

/**
 * Handle scroll keys. Returns updated offsets or null if the
 * key wasn't a scroll key.
 */
export function handleScrollKeys(
	data: string,
	vOffset: number,
	hOffset: number,
	budget: number,
): { vOffset: number; hOffset: number } | null {
	if (matchesKey(data, "pageup") || matchesKey(data, "shift+up")) {
		return { vOffset: Math.max(0, vOffset - budget), hOffset };
	}
	if (matchesKey(data, "pagedown") || matchesKey(data, "shift+down")) {
		return { vOffset: vOffset + budget, hOffset };
	}
	if (matchesKey(data, "shift+left")) {
		return { vOffset, hOffset: Math.max(0, hOffset - H_SCROLL_STEP) };
	}
	if (matchesKey(data, "shift+right")) {
		return { vOffset, hOffset: hOffset + H_SCROLL_STEP };
	}
	return null;
}

/**
 * Handle option navigation keys. Returns the new selected index
 * or null if the key wasn't a navigation key.
 */
export function handleOptionNav(
	data: string,
	selected: number,
	optionCount: number,
): number | null {
	if (matchesKey(data, Key.up)) {
		return Math.max(0, selected - 1);
	}
	if (matchesKey(data, Key.down)) {
		return Math.min(optionCount - 1, selected + 1);
	}
	return null;
}

/**
 * Resolve a confirmation key press. Number keys select and
 * confirm in one step; Enter confirms the current selection.
 * Returns the confirmed option index, or null if the key
 * wasn't a confirmation key.
 */
export function resolveConfirmation(
	data: string,
	currentSelected: number,
	optionCount: number,
): number | null {
	const num = Number.parseInt(data, 10);
	if (num >= 1 && num <= optionCount) {
		return num - 1;
	}
	if (matchesKey(data, Key.enter)) {
		return currentSelected;
	}
	return null;
}

/**
 * Handle tab navigation keys (multi-page panels). Returns the
 * new tab index or null if the key wasn't a tab navigation key.
 */
export function handleTabNav(
	data: string,
	currentTab: number,
	pageCount: number,
): number | null {
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
		return (currentTab + 1) % pageCount;
	}
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
		return (currentTab - 1 + pageCount) % pageCount;
	}
	return null;
}

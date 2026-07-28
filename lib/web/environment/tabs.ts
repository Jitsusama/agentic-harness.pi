/**
 * The tabs a session can see.
 *
 * A session drives one tab at a time, which is almost always what
 * is wanted and is wrong exactly when a page opens another one: a
 * target of _blank, a window.open, a payment or sign-in handed to
 * a second window. What the page did then is real and invisible,
 * and the last thing a caller sees is a click that appeared to do
 * nothing.
 */

/** One tab the session's browser context is holding open. */
export interface TabRecord {
	/** Its place in the list, from one, as a caller names it. */
	readonly index: number;
	readonly url: string;
	readonly title: string;
	/** Whether this is the one every read and act goes to. */
	readonly current: boolean;
}

/** The tabs open, and which one is being driven. */
export function renderTabs(tabs: readonly TabRecord[]): string {
	if (tabs.length === 0) return "No tabs open.";
	if (tabs.length === 1) {
		const only = tabs[0] as TabRecord;
		return `One tab: ${describe(only)}`;
	}

	const lines = tabs.map(
		(tab) =>
			`${tab.index}. ${describe(tab)}${tab.current ? "  <- driving" : ""}`,
	);
	return [`${tabs.length} tabs open:`, ...lines].join("\n");
}

/** A tab in one line, title first because that is what is read. */
function describe(tab: TabRecord): string {
	return tab.title === "" ? tab.url : `${tab.title} (${tab.url})`;
}

/**
 * Pick the tab asked for, or refuse by saying what is open.
 *
 * The refusal carries the list because the caller's next move is
 * always to ask for it, and making them spend a call to learn
 * what was already in hand when the refusal was written is a
 * needless round trip.
 */
export function chooseTab(
	tabs: readonly TabRecord[],
	wanted: number,
): TabRecord | { refusal: string } {
	const found = tabs.find((tab) => tab.index === wanted);
	if (found !== undefined) return found;

	if (tabs.length === 0) {
		return {
			refusal:
				"There are no tabs open to switch to, which means the session " +
				"has no page at all rather than the wrong one.",
		};
	}
	return {
		refusal: `There is no tab ${wanted}. Open are:\n${renderTabs(tabs)}`,
	};
}

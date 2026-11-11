/**
 * What a screen reader would have said out loud.
 *
 * A sighted reviewer sees a banner appear. A screen reader user
 * hears something, or hears nothing at all, and nothing is the
 * bug worth catching. Live regions are the mechanism a page
 * uses to speak, so watching them answers "what did a screen
 * reader user hear when I pressed save".
 */

import { pageCall } from "../page-script.ts";
import type { Recorded } from "../telemetry/buffer.ts";

/** Something the page announced through a live region. */
export interface Announcement {
	readonly politeness: "polite" | "assertive";
	readonly text: string;
	/** When it was announced, as epoch milliseconds. */
	readonly at: number;
}

/** Lay out what was announced, in the order it was said. */
export function renderAnnouncements(
	entries: readonly Recorded<Announcement>[],
	dropped = 0,
): string {
	if (entries.length === 0) return "Nothing was announced.";

	const lines = entries.map(
		({ item }) => `${item.politeness}: ${flatten(item.text)}`,
	);
	if (dropped > 0) {
		// First, where the missing ones would have been: the buffer
		// drops the oldest, so the gap is at the top. It used to go last,
		// which put the one line saying announcements were lost at the
		// end of the longest possible view, where a budget removes it. A
		// reader was then told nothing at all about the gap, which is
		// worse than a long answer.
		lines.unshift(`${dropped} earlier announcements were dropped.`, "");
	}
	return lines.join("\n");
}

/** Put an announcement on one line, the way it is heard. */
function flatten(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The binding an injected observer reports through. */
export const ANNOUNCE_BINDING = "__piAnnounce";

/** The page-side array of regions the observer has nominated. */
export const CANDIDATE_REGISTRY = "__piLiveCandidates";

/**
 * A change the page made somewhere that might be announced.
 *
 * The observer decides nothing about whether this is a live
 * region. It reports where the change happened and lets the
 * browser rule on it.
 */
export interface AnnouncementCandidate {
	/** Identifies the document; a navigation starts a new one. */
	readonly epoch: string;
	/** Position in the page-side registry of nominated regions. */
	readonly index: number;
	readonly text: string;
	readonly at: number;
}

/**
 * Watch the page for anything that might be spoken.
 *
 * This is page source, in announcement-observer.page.js, rather
 * than a function, on purpose. Injecting a function serializes whatever the
 * compiler made of it, and esbuild's keepNames wraps every
 * named inner binding in a call to a __name helper. The page
 * has never heard of __name, so the script throws before it
 * registers, and nothing says so. A lone inline arrow is safe,
 * which is why the simple evaluate callbacks elsewhere in this
 * library are still written as functions; anything declaring
 * helpers of its own is not. Source text survives untouched.
 *
 * It runs before the page's own scripts, so changes made during
 * load are caught too. It reports through a binding the session
 * installs; with no binding it does nothing rather than throwing
 * inside the page under inspection.
 *
 * It deliberately does not decide politeness. Chrome exposes no
 * way for page script to ask what the browser computed, and
 * reimplementing the rules here means missing whatever the
 * browser knows that this code does not: role=log is live,
 * aria-live=off is not, and the mapping changes as the ARIA
 * spec grows. So the observer nominates any region that could
 * plausibly carry live semantics and the browser rules on it.
 * Over-nominating costs one lookup; under-nominating loses an
 * announcement silently, which is the failure that matters.
 */
export const ANNOUNCEMENT_OBSERVER = pageCall(
	new URL("./announcement-observer.page.js", import.meta.url),
	{ values: { BINDING: ANNOUNCE_BINDING, REGISTRY: CANDIDATE_REGISTRY } },
);

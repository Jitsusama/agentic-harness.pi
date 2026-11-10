/**
 * What holds focus at this moment.
 *
 * Distinct from the keyboard walk, which presses Tab around the whole
 * page and judges the journey. This answers the question asked
 * between actions: after that click, that key, that navigation, where
 * did focus end up? It moves nothing.
 */

import { pageScript } from "../page-script.ts";

/**
 * Ask the page what holds focus, without moving it.
 *
 * Kept as page source, in focus-probe.page.js, because it declares
 * helpers. The
 * accessible name is read the cheap way, from the attributes and
 * text that produce one, rather than from the accessibility tree:
 * this has to answer between actions without a tree walk, and the
 * name is only there to identify what is already known to be
 * focused.
 */
export const FOCUS_PROBE = pageScript(
	new URL("./focus-probe.page.js", import.meta.url),
);

/** The element focus is on, as the page reports it. */
export interface FocusHolder {
	readonly tag: string;
	readonly role?: string;
	readonly name?: string;
	readonly id?: string;
	/** Focus is parked on the body, which means nothing holds it. */
	readonly onBody: boolean;
	readonly inShadow?: boolean;
	readonly rect?: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
}

/** Say what holds focus, in the vocabulary the outline uses. */
export function renderFocus(holder: FocusHolder | undefined): string {
	if (!holder) {
		return (
			"WARN what holds focus could not be read\n\n" +
			"The page did not answer, which happens when nothing is " +
			"loaded yet. Navigate, then ask again."
		);
	}

	if (holder.onBody) {
		// Naming the body as the holder would read as a real control and
		// hide the useful finding, which is that a key press went
		// nowhere.
		return (
			"Nothing holds focus.\n\n" +
			"Focus is parked on the document, which is where the browser " +
			"leaves it when no control has been given it. A tab from here " +
			"starts at the top of the page."
		);
	}

	// The role and name pair is how every other surface here addresses
	// an element, so the answer can be pasted straight into a target.
	const called = holder.role ?? holder.tag;
	const named = holder.name ? ` "${holder.name}"` : "";
	const notes = [
		holder.role && holder.role !== holder.tag ? `<${holder.tag}>` : "",
		holder.id ? `#${holder.id}` : "",
		holder.inShadow ? "inside a shadow root" : "",
		holder.rect ? `at ${place(holder.rect)}` : "",
	].filter(Boolean);
	const tail = notes.length > 0 ? `\n\n${notes.join(", ")}` : "";
	return `${called}${named} holds focus.${tail}`;
}

function place(rect: NonNullable<FocusHolder["rect"]>): string {
	return (
		`${Math.round(rect.x)},${Math.round(rect.y)} ` +
		`${Math.round(rect.width)}x${Math.round(rect.height)}`
	);
}

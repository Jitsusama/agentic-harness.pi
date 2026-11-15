/**
 * Where keyboard focus goes: the walk that presses Tab through the
 * page and reports what each stop looked like, and what holds
 * focus right now.
 *
 * Kept apart from the session because the walk is the one reading
 * that moves the page to learn about it, with its own budget, its
 * own escape probe and its own promise to hand the page back as
 * found. Those change with what a keyboard user's barriers are,
 * not with how anything else is read.
 */

import {
	FOCUS_PROBE,
	type FocusHolder,
	type Unreachable,
	WALK_COLLECT,
	WALK_READ,
	WALK_REMEMBER,
	WALK_RESTORE,
	type WalkCandidate,
	type WalkCapture,
	type WalkStop,
} from "../a11y/index.ts";
import type { SessionWires } from "./wires.ts";

/** Extra stops beyond two full passes, to show a cycle clearly. */
const WALK_SLACK = 4;

/**
 * How far the walk goes when nobody said, however large the page.
 *
 * A ceiling on the default rather than on the caller: asked for
 * more stops than this, the walk takes them.
 */
const MAX_WALK_STOPS = 400;

/** How many trailing stops to inspect for being stuck. */
const WALK_STUCK_SAMPLE = 4;

/** What a stop outside the candidates has for a style. */
const BLANK_STYLE = {
	outlineStyle: "none",
	outlineWidth: "0px",
	outlineColor: "",
	boxShadow: "none",
	backgroundColor: "",
	borderColor: "",
	color: "",
} as const;

/** The keyboard's path through the page, read through the tab. */
export class SessionFocus {
	/** The live view of the browser the walk presses keys through. */
	private readonly wires: SessionWires;

	constructor(wires: SessionWires) {
		this.wires = wires;
	}

	/**
	 * Walk the page with the Tab key and report what happened.
	 *
	 * This is one of the two reads that deliberately change the
	 * page, since there is no way to learn where focus goes
	 * without moving it. Focus is put back afterwards and the
	 * result says so.
	 *
	 * The walk runs to twice the number of focusable things plus a
	 * little, which is enough for a healthy page to come round
	 * twice and for a trap to show its cycle. Stopping sooner
	 * would report a trap as a short page.
	 */
	async keyboardWalk(maxStops?: number): Promise<WalkCapture> {
		await this.wires.ready();

		// Remember where the caller's focus and viewport were before
		// disturbing either, so the page can be handed back as found.
		await this.evaluateJson(WALK_REMEMBER);

		// Start from the top of the document so the first Tab lands
		// where a reader arriving at the page would land, not
		// wherever something happened to leave focus.
		//
		// This has to happen before the resting styles are collected,
		// not after. A dialog opened with showModal focuses its first
		// control, so collecting first recorded that control's focused
		// appearance as its resting one, and comparing the two later
		// found no difference and reported a perfectly visible focus
		// ring as missing.
		await this.wires.page().evaluate(() => {
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
		});

		const collected = await this.evaluateJson<{
			candidates: WalkCandidate[];
			unreachable: Unreachable[];
		}>(WALK_COLLECT);

		// The ceiling belongs to the default, not to the caller. It
		// used to apply to both, so a page with more controls than
		// the ceiling could not be walked to the end by any argument,
		// while the report that ran out of budget told the caller to
		// raise maxStops and walk the rest. Every larger number gave
		// the same four hundred stops and the same advice again.
		const cap =
			maxStops ??
			Math.min(collected.candidates.length * 2 + WALK_SLACK, MAX_WALK_STOPS);

		const stops: WalkStop[] = [];
		for (let step = 0; step < cap; step += 1) {
			await this.wires.page().keyboard.press("Tab");
			const stop = await this.evaluateJson<WalkStop & { focused: unknown }>(
				WALK_READ,
			);
			if (stop.focused === null) {
				stops.push({ ...stop, focused: BLANK_STYLE });
				continue;
			}
			stops.push(stop as WalkStop);
		}

		// If the walk ended stuck somewhere smaller than the page,
		// find out whether a keyboard user has any way back. That is
		// the difference between a modal and a dead end.
		//
		// The test used to be "any index repeats in the last four
		// stops", which every page whose tab cycle is three stops or
		// shorter satisfies on a healthy run, so Escape was pressed on
		// ordinary login forms. A page is only worth probing when the
		// loop it settled into is smaller than the set of things it
		// could have reached.
		let escapeFreed: boolean | undefined;
		const tail = stops.slice(-WALK_STUCK_SAMPLE).map((stop) => stop.index);
		const reached = new Set(
			stops.map((stop) => stop.index).filter((index) => index >= 0),
		);
		const loopedSmall =
			tail.length > 0 &&
			new Set(tail).size < tail.length &&
			reached.size < collected.candidates.length;
		if (loopedSmall) {
			const before = tail.at(-1);
			await this.wires.page().keyboard.press("Escape");
			await this.wires.page().keyboard.press("Tab");
			const after = await this.evaluateJson<WalkStop>(WALK_READ);
			escapeFreed = after.index !== before && !tail.includes(after.index);
		}

		await this.evaluateJson(WALK_RESTORE);

		// A walk that used its whole budget has not necessarily seen
		// the page. Saying so is what stops everything it did not
		// reach being reported as unreachable.
		const exhausted =
			stops.length >= cap && reached.size < collected.candidates.length;

		return {
			candidates: collected.candidates,
			stops,
			unreachable: collected.unreachable,
			...(escapeFreed === undefined ? {} : { escapeFreed }),
			...(exhausted ? { cappedAt: cap } : {}),
			// Which way the page reads has to come from the page. The
			// side-by-side order that is wrong in English is correct in
			// Arabic, and guessing left-to-right would report every
			// right-to-left toolbar as backwards.
			direction: await this.readingDirection(),
		};
	}

	/** Which way the document says it reads. */
	private async readingDirection(): Promise<"ltr" | "rtl"> {
		try {
			const reads = await this.wires.page().evaluate(
				() => getComputedStyle(document.documentElement).direction,
			);
			return reads === "rtl" ? "rtl" : "ltr";
		} catch {
			// Left-to-right is the safe default: it is what most pages
			// are, and being wrong here only costs a finding nobody
			// asked for rather than a missed barrier.
			return "ltr";
		}
	}

	/**
	 * What holds focus at this moment, moving nothing.
	 *
	 * The keyboard walk answers what a whole page does; this answers
	 * where focus is right now, which is the question between
	 * actions. It reads rather than presses, so it can be asked after
	 * a click or a navigation without disturbing what it reports.
	 */
	async focusHolder(): Promise<FocusHolder | undefined> {
		await this.wires.ready();
		const { result } = await this.wires.cdp().send("Runtime.evaluate", {
			expression: FOCUS_PROBE,
			returnByValue: true,
		});
		return result.value as FocusHolder | undefined;
	}

	/** Run a page-side source string and read back its value. */
	private async evaluateJson<T>(source: string): Promise<T> {
		const { result } = await this.wires.cdp().send("Runtime.evaluate", {
			expression: source,
			returnByValue: true,
		});
		return result.value as T;
	}
}

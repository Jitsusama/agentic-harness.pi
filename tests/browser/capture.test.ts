/**
 * Pictures, baselines, one element in depth, the keyboard walk
 * and what the load cost.
 *
 * These are the expensive readings, and the ones whose answers a
 * person acts on directly. None had a test. The cases worth
 * writing are where the answer is a judgment: a baseline recorded
 * on one page and compared against another, a walk that has to
 * put focus back where it found it, an element whose visibility
 * depends on which of several ways the page hid it.
 */

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const SUBJECT = page(
	"Capture",
	`<main>
  <h1>Capture</h1>
  <a href="#one" id="first">First link</a>
  <button type="button" id="second">Second control</button>
  <input id="third" aria-label="Third control">
  <p id="prose" style="color:#767676;background:#ffffff">Low contrast prose.</p>
  <p id="hidden-attr" hidden>Hidden by attribute.</p>
  <p id="display-none" style="display:none">Hidden by display.</p>
  <p id="clipped" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Announced but not seen.</p>
</main>`,
);

const OTHER = page("Other", "<main><h1>A different page entirely</h1></main>");

/** A page whose only control cannot be reached by keyboard. */
const TRAP = page(
	"Trap",
	`<main><h1>Trap</h1>
<div id="fake" onclick="void 0">Looks like a button, is not focusable</div>
</main>`,
);

/**
 * A link whose own box collapses around its content.
 *
 * The shape is Wikipedia's section edit links: an anchor whose
 * only child is floated, so the anchor measures 35 by 0 while
 * the text inside it is plainly painted. The walk called every
 * one of them focused off screen.
 */
const COLLAPSED = page(
	"Collapsed",
	`<main><h1>Collapsed</h1>
<a href="#x" id="collapsed"><span style="float:left">edit</span></a>
</main>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)("capturing a page, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/subject", body: SUBJECT },
			{ path: "/other", body: OTHER },
			{ path: "/trap", body: TRAP },
			{ path: "/collapsed", body: COLLAPSED },
		]);
		session = await BrowserSession.open("capture-contract");
		await session.navigate(fixture.url("/subject"));
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	it("writes a screenshot to disk rather than returning it", async () => {
		// An image inline is the single largest thing a tool can put
		// in a context window, and it is never what the caller wanted.
		const shot = await session.shoot();

		expect(shot.ok).toBe(true);
		if (!shot.ok) return;
		expect(shot.shot.paths.length).toBeGreaterThan(0);
		for (const path of shot.shot.paths) expect(fs.existsSync(path)).toBe(true);
	});

	it("photographs one element when told which", async () => {
		const shot = await session.shoot({
			target: { role: "button", name: "Second control" },
		});

		expect(shot.ok).toBe(true);
	});

	it("refuses to photograph an element that is not there", async () => {
		const shot = await session.shoot({
			target: { role: "button", name: "No such control" },
		});

		expect(shot.ok).toBe(false);
	});

	it("records a baseline the first time and compares to it after", async () => {
		const label = `capture-${Date.now()}`;

		const first = await session.compareToBaseline(label);
		expect(first.recorded).toBeDefined();
		expect(first.comparison).toBeUndefined();

		const second = await session.compareToBaseline(label);
		expect(second.comparison).toBeDefined();
	});

	it("refuses to diff a baseline taken on a different page", async () => {
		// Without this the diff reports confident failures attributed
		// to the second page's elements. Two pages at one viewport are
		// the same size, so the size check alone cannot see it.
		const label = `drift-${Date.now()}`;
		await session.navigate(fixture.url("/subject"));
		await session.compareToBaseline(label);

		try {
			await session.navigate(fixture.url("/other"));
			const compared = await session.compareToBaseline(label);

			// Reported as incomparable rather than returned empty: a
			// caller who asked for a diff needs to know they were given
			// none, and why, or they read silence as no change.
			expect(compared.comparison?.kind).toBe("incomparable");
		} finally {
			// In a finally, because a restoration after an assertion does
			// not run when the assertion fails. Putting it last left the
			// session on the wrong page and failed the next three tests
			// for reasons that had nothing to do with them.
			await session.navigate(fixture.url("/subject"));
		}
	});

	it("walks the page by keyboard and reports where focus went", async () => {
		const walk = await session.keyboardWalk();

		expect(walk.candidates.length).toBeGreaterThan(0);
		expect(walk.stops.length).toBeGreaterThan(0);
	});

	it("does not call a painted link off screen when its box collapsed", async () => {
		await session.navigate(fixture.url("/collapsed"));
		try {
			const walk = await session.keyboardWalk();
			const stop = walk.stops.find((one) => one.id === "collapsed");

			// The link sits at the top of a 600px viewport with text a
			// reader can see. Judging it by its own width and height
			// reported it as focused off screen, which on a real article
			// produced twenty-seven identical findings, every one wrong.
			expect(stop).toBeDefined();
			expect(stop?.inViewport).toBe(true);
		} finally {
			await session.navigate(fixture.url("/subject"));
		}
	});

	it("walks as far as it is asked to, past its own default ceiling", async () => {
		// The report tells a caller who ran out of budget to "raise
		// maxStops to walk the rest". A ceiling of 400 was applied to
		// the caller's number as well as to the default, so on a page
		// with more controls than that the advice could not be taken:
		// every larger number produced the same 400 stops.
		const walk = await session.keyboardWalk(420);

		expect(walk.stops.length).toBe(420);
	});

	it("puts focus back where it found it", async () => {
		// A walk moves focus as its whole method. Leaving it somewhere
		// else changes the page for whatever the caller does next.
		await session.evaluate("document.getElementById('third').focus()");

		await session.keyboardWalk();

		const active = await session.evaluate("document.activeElement.id");
		expect(active.ok && active.result.value).toBe("third");
	});

	it("notices a control a keyboard cannot reach", async () => {
		await session.navigate(fixture.url("/trap"));
		try {
			const walk = await session.keyboardWalk();

			// The div is clickable and not focusable, which is the most
			// common keyboard fault on a real page. Tab still produces
			// stops, because focus cycles through the document and the
			// browser's own chrome; what says nobody can reach the
			// control is that there were no candidates and every stop
			// landed on the body rather than on anything in the page.
			expect(walk.candidates).toHaveLength(0);
			expect(walk.stops.every((stop) => stop.index === -1)).toBe(true);
		} finally {
			await session.navigate(fixture.url("/subject"));
		}
	});

	it("measures what the load cost", async () => {
		const measured = await session.vitals();

		expect(measured).toBeDefined();
	});

	it("inspects one element and reports its box", async () => {
		const found = await session.inspect({
			role: "button",
			name: "Second control",
		});

		expect(found.ok).toBe(true);
		if (!found.ok) return;
		expect(found.inspection.box).toBeDefined();
	});

	it("refuses to inspect what is not there, rather than inventing a box", async () => {
		const found = await session.inspect({
			role: "button",
			name: "Nothing of the sort",
		});

		expect(found.ok).toBe(false);
	});

	it("tells apart the several ways a page hides something", async () => {
		// Hidden, display none and clipped-but-announced are three
		// different facts about a page, and collapsing them loses the
		// one that matters to a screen reader user.
		const outline = (await session.observe()).outline;

		expect(outline).not.toContain("Hidden by attribute");
		expect(outline).not.toContain("Hidden by display");
		expect(outline).toContain("Announced but not seen");
	});
});

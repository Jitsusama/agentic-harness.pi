/**
 * The keyboard walk as a person reads it: what the report leads
 * with, how it names a trap, a modal and a walk cut short, and what
 * its verdict claims. Every fixture mirrors a shape taken from a
 * real capture.
 */

import { describe, expect, it } from "vitest";
import { analyseWalk, renderWalk } from "../../../../lib/core/web/a11y/walk.ts";
import { AT_REST, candidate, capture, stop } from "./walk-fixture.ts";

describe("renderWalk", () => {
	const trapped = analyseWalk(
		capture({
			candidates: [
				candidate(0, "Outside"),
				candidate(1, "Trapped one"),
				candidate(2, "Trapped two"),
			],
			stops: [
				stop(1, "Trapped one"),
				stop(2, "Trapped two"),
				stop(1, "Trapped one"),
				stop(2, "Trapped two"),
			],
		}),
	);

	it("bounds a finding list the way it bounds the tab order", () => {
		// A live article produced two hundred and fifty unvisited
		// controls and printed every one, while the tab order beside
		// them stopped at forty and said how many more there were.
		// One report, two rules, and the unbounded one was longer
		// than everything else in the answer put together.
		const many = analyseWalk(
			capture({
				candidates: Array.from({ length: 90 }, (_, at) =>
					candidate(at, `Control ${at}`),
				),
				stops: [stop(0, "Control 0")],
				cappedAt: 1,
			}),
		);

		const out = renderWalk(many);
		const listed = out
			.split("\n")
			.filter((line) => /^ {2}Control \d+$/.test(line));

		expect(listed.length).toBeLessThan(89);
		expect(out).toMatch(/\.\.\. and \d+ more/);
	});

	it("leads with the trap, which is the worst thing it can find", () => {
		expect(renderWalk(trapped).split("\n").slice(0, 4).join("\n")).toContain(
			"FOCUS TRAP",
		);
	});

	it("says plainly that Escape does not help", () => {
		expect(renderWalk(trapped)).toContain("Escape does not get out");
	});

	it("marks stops with no ring in the order listing", () => {
		const out = renderWalk(
			analyseWalk(
				capture({
					candidates: [candidate(0, "Bare")],
					stops: [stop(0, "Bare", { focused: AT_REST })],
				}),
			),
		);
		expect(out).toContain("[no ring]");
	});

	it("explains why a positive tabindex matters, not just that it exists", () => {
		const out = renderWalk(
			analyseWalk(
				capture({
					candidates: [candidate(0, "Pushy", { tabindex: 3 })],
					stops: [stop(0, "Pushy")],
				}),
			),
		);
		expect(out).toContain("ahead of everything else");
	});

	it("reports a clean page without inventing problems", () => {
		const out = renderWalk(
			analyseWalk(
				capture({
					candidates: [candidate(0, "One"), candidate(1, "Two")],
					stops: [stop(0, "One"), stop(1, "Two")],
				}),
			),
		);
		expect(out).not.toContain("TRAP");
		expect(out).not.toContain("[no ring]");
		expect(out).toContain("2 distinct stops");
	});

	it("shows a cycled order once, not once per lap", () => {
		// The walk goes round more than once on purpose. Printing
		// every lap would spend the whole budget saying one thing.
		const out = renderWalk(
			analyseWalk(
				capture({
					candidates: [candidate(0, "One"), candidate(1, "Two")],
					stops: [
						stop(0, "One"),
						stop(1, "Two"),
						stop(0, "One"),
						stop(1, "Two"),
						stop(0, "One"),
					],
				}),
			),
		);
		expect(out.match(/One/g) ?? []).toHaveLength(1);
		expect(out).toContain("then the order repeated");
	});
});

describe("a trap focus walked into and cannot walk out of", () => {
	// Mirrors a real capture of two links followed by two buttons
	// that swallow Tab between themselves. Tab from the top reaches
	// all four, so nothing is unvisited; the links are still
	// unreachable once focus is inside the pair, which is the whole
	// complaint. Asking which controls were never visited called
	// this clean and passed the reference keyboard trap.
	const oneWay = analyseWalk(
		capture({
			candidates: [
				candidate(0, "Outside link", { tag: "A" }),
				candidate(1, "Outside button"),
				candidate(2, "In A"),
				candidate(3, "In B"),
			],
			stops: [
				stop(0, "Outside link", { tag: "A" }),
				stop(1, "Outside button"),
				stop(2, "In A"),
				stop(3, "In B"),
				stop(2, "In A"),
				stop(3, "In B"),
				stop(2, "In A"),
				stop(3, "In B"),
			],
		}),
	);

	it("calls it a trap even though every control was visited", () => {
		expect(oneWay.trap).toBeDefined();
		expect(oneWay.missed).toEqual([]);
	});

	it("counts the controls outside the cycle, not the unvisited ones", () => {
		expect(oneWay.trap?.stranded.map((one) => one.name)).toEqual([
			"Outside link",
			"Outside button",
		]);
	});

	it("names the stranded controls, since a count is not actionable", () => {
		const report = renderWalk(oneWay);
		expect(report).toContain("2 controls are stranded outside it");
		expect(report).toContain("Outside link");
		expect(report).toContain("Outside button");
	});

	it("lists the cycle in document order, not where the repeat began", () => {
		expect(renderWalk(oneWay)).toContain("tab only ever reaches In A, In B");
	});

	it("agrees in number when only one control is shut out", () => {
		const single = analyseWalk(
			capture({
				candidates: [candidate(0, "Lonely"), candidate(1, "Ring")],
				stops: [stop(0, "Lonely"), stop(1, "Ring"), stop(1, "Ring")],
			}),
		);
		expect(renderWalk(single)).toContain("1 control is stranded outside it");
	});

	it("leaves a page whose whole order cycles alone", () => {
		// The ordinary case: tab goes round everything and comes back.
		// A cycle is what a working tab order looks like.
		const healthy = analyseWalk(
			capture({
				candidates: [candidate(0, "One"), candidate(1, "Two")],
				stops: [stop(0, "One"), stop(1, "Two"), stop(0, "One"), stop(1, "Two")],
			}),
		);
		expect(healthy.trap).toBeUndefined();
		expect(renderWalk(healthy)).toMatch(/^PASS/);
	});
});

describe("telling a contained page from a broken one", () => {
	// A modal that holds focus, exactly as the pattern prescribes:
	// its two controls cycle, and the three behind it are excluded
	// on purpose. Index -1 is focus resting on the body between
	// laps, which headless Chrome does every time round.
	const modal = () =>
		capture({
			candidates: [
				candidate(0, "Background link"),
				candidate(1, "Open dialog"),
				candidate(2, "Another"),
				candidate(3, "Cancel", { inModal: true }),
				candidate(4, "Save", { inModal: true }),
			],
			// The index sequence a real showModal dialog produced:
			// captured from the browser rather than imagined, because a
			// shorter invented one has no detectable cycle at all and
			// would pass this test for the wrong reason.
			stops: [4, -1, 3, 4, 3, 4, -1, 3, 4, 3, 4, -1, 3, 4].map((index) =>
				index < 0
					? stop(-1, "BODY")
					: stop(index, index === 3 ? "Cancel" : "Save", { inModal: true }),
			),
			cappedAt: 14,
		});

	it("does not call a correct modal a focus trap", () => {
		const findings = analyseWalk(modal());

		expect(findings.trap).toBeUndefined();
		expect(findings).toMatchObject({ modalHeldFocus: true });
		expect(renderWalk(findings)).toMatch(/^PASS/);
	});

	it("does not blame a modal for the controls it excludes", () => {
		// The walk laps inside the dialog and spends its whole
		// budget, so the cap fires. The dialog was the limit, not
		// the budget, and saying "raise maxStops" would be wrong.
		const report = renderWalk(analyseWalk(modal()));

		expect(report).not.toContain("maxStops");
		expect(report).not.toContain("never reached");
	});

	it("still fails a cycle that is not a modal", () => {
		// Same shape, no dialog. This is the real defect the check
		// exists to find, and it must survive the modal exception.
		const findings = analyseWalk(
			capture({
				candidates: [
					candidate(0, "Outside link"),
					candidate(1, "Outside button"),
					candidate(2, "In A"),
					candidate(3, "In B"),
				],
				stops: [2, 3, 2, 3, 2, 3, 2, 3].map((index) =>
					stop(index, index === 2 ? "In A" : "In B"),
				),
				cappedAt: 12,
			}),
		);

		expect(findings.trap).toBeDefined();
		expect(renderWalk(findings)).toMatch(/^FAIL/);
	});
});

describe("a walk cut short blames its own budget", () => {
	it("reports unvisited controls as unvisited, not unreachable", () => {
		// maxStops is a documented parameter, and it used to be the
		// shortest route to a fabricated critical verdict: every
		// control the budget stopped us reaching was counted as a
		// hard failure against the page.
		const findings = analyseWalk(
			capture({
				candidates: [
					candidate(0, "One"),
					candidate(1, "Two"),
					candidate(2, "Three"),
				],
				stops: [stop(0, "One")],
				cappedAt: 1,
			}),
		);

		const report = renderWalk(findings);
		expect(findings.missed).toHaveLength(2);
		expect(report).toMatch(/^WARN/);
		expect(report).toContain("budget");
	});

	it("fails them when the walk really did finish", () => {
		const findings = analyseWalk(
			capture({
				candidates: [candidate(0, "One"), candidate(1, "Stranded")],
				stops: [stop(0, "One")],
			}),
		);

		expect(renderWalk(findings)).toMatch(/^FAIL/);
	});
});

describe("the verdict claims only what a tab walk tested", () => {
	it("does not say the order is right or the controls work", () => {
		// Only Tab was pressed, and the order was compared against
		// document order, so neither visual order nor operability
		// was tested. The clean headline used to assert both.
		const report = renderWalk(
			analyseWalk(
				capture({
					candidates: [candidate(0, "One")],
					stops: [stop(0, "One")],
				}),
			),
		);

		expect(report).toMatch(/^PASS/);
		expect(report).toContain("Tab reached every control");
	});
});

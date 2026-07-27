/**
 * The health digest's running order.
 *
 * Ordinarily extension wiring is left to live driving, but this
 * order is not a presentation choice: it decides whether the
 * page or the auditor is charged for the auditor's work, and
 * nothing about reading the digest would reveal a regression.
 */

import { describe, expect, it } from "vitest";
import { HEALTH_RUN_ORDER } from "../../../extensions/browser-integration/check.js";

describe("the health digest", () => {
	it("measures the page before any check disturbs it", () => {
		// axe injects and runs, and the keyboard walk presses tab up
		// to four hundred times, both on the page's own main thread
		// while the page's own observers watch. Run in reading order,
		// the digest charged the page six hundred milliseconds of its
		// auditor's blocking and reported FAIL for a page that scored
		// zero on its own.
		expect(HEALTH_RUN_ORDER[0]).toBe("perf");
	});

	it("still runs every check it reports", () => {
		expect([...HEALTH_RUN_ORDER].sort()).toEqual(
			["accessibility", "design", "keyboard", "perf", "visual"].sort(),
		);
	});
});

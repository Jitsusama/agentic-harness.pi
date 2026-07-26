/**
 * Sweeping a check across conditions, and reporting where it
 * starts going wrong.
 */

import { describe, expect, it } from "vitest";
import {
	type Condition,
	conditionFrom,
	DEFAULT_WIDTHS,
	headlineOf,
	renderSweep,
	standingOf,
	widthsToSweep,
	worstOf,
} from "../../../../lib/web/audit/sweep.js";

const at = (
	label: string,
	standing: Condition["standing"],
	headline = "something",
): Condition => ({ label, standing, headline, detail: `${label} in full` });

describe("worstOf", () => {
	it("lets one failure decide the whole sweep", () => {
		expect(worstOf(["pass", "pass", "fail", "warn"])).toBe("fail");
	});

	it("falls back to a warning when nothing failed", () => {
		expect(worstOf(["pass", "warn"])).toBe("warn");
	});

	it("passes only when everything did", () => {
		expect(worstOf(["pass", "pass"])).toBe("pass");
	});
});

describe("renderSweep", () => {
	it("says so when there was nothing to sweep", () => {
		expect(renderSweep([])).toContain("No conditions were swept");
	});

	it("names where a sweep starts failing rather than only that it does", () => {
		// A run of passes ending in failures at the narrow end names
		// a breakpoint, which is the reason to sweep at all.
		const out = renderSweep([
			at("375px", "fail"),
			at("768px", "pass"),
			at("1280px", "pass"),
		]);
		expect(out).toContain("Fails at 375px, and passes elsewhere");
	});

	it("lists several failing conditions the way a person would", () => {
		const out = renderSweep([
			at("375px", "fail"),
			at("768px", "fail"),
			at("1280px", "pass"),
		]);
		expect(out).toContain("Fails at 375px and 768px, and passes elsewhere");
	});

	it("says plainly when everything fails", () => {
		const out = renderSweep([at("375px", "fail"), at("768px", "fail")]);
		expect(out).toContain("Fails under all 2 conditions");
	});

	it("reports a clean sweep as a measured fact", () => {
		const out = renderSweep([at("375px", "pass"), at("768px", "pass")]);
		expect(out).toContain("Clean under all 2 conditions");
		expect(out).toContain("under 2 conditions");
	});

	it("does not call a sweep clean when something warned", () => {
		const out = renderSweep([at("375px", "warn"), at("768px", "pass")]);
		expect(out.startsWith("WARN")).toBe(true);
		expect(out).toContain("1 of 2 conditions raised something");
	});

	it("keeps the conditions in the order they were run", () => {
		// Sorted worst-first, the table would name no boundary.
		const out = renderSweep([
			at("375px", "fail"),
			at("768px", "pass"),
			at("1280px", "fail"),
		]);
		const labels = out
			.split("\n")
			.filter((line) => line.startsWith("  "))
			.map((line) => line.trim().split(/\s+/)[0]);
		expect(labels).toEqual(["375px", "768px", "1280px"]);
	});

	it("gives one condition in full when asked for it", () => {
		const out = renderSweep([at("375px", "fail"), at("768px", "pass")], {
			only: "375px",
		});
		expect(out).toBe("375px in full");
	});

	it("lists what was run when asked for a condition that was not", () => {
		expect(renderSweep([at("375px", "fail")], { only: "999px" })).toContain(
			"375px",
		);
	});
});

describe("widthsToSweep", () => {
	it("covers phone to desktop by default", () => {
		expect(widthsToSweep().map((one) => one.label)).toEqual([
			"375px",
			"768px",
			"1280px",
			"1920px",
		]);
		expect(DEFAULT_WIDTHS).toHaveLength(4);
	});

	it("takes the caller's widths instead", () => {
		expect(widthsToSweep([320]).map((one) => one.setting.width)).toEqual([320]);
	});
});

describe("reading a rendered report back", () => {
	it("recovers the standing", () => {
		expect(standingOf("FAIL  3 rules failed")).toBe("fail");
		expect(standingOf("WARN  something")).toBe("warn");
		expect(standingOf("PASS  nothing")).toBe("pass");
	});

	it("recovers the headline without its mark", () => {
		expect(headlineOf("FAIL  3 rules failed\nmore")).toBe("3 rules failed");
	});

	it("builds a condition from a report", () => {
		const condition = conditionFrom("375px", "FAIL  it broke\ndetail here");
		expect(condition.standing).toBe("fail");
		expect(condition.headline).toBe("it broke");
		expect(condition.detail).toContain("detail here");
	});
});

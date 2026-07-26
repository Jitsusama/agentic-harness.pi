/**
 * The composed digest.
 */

import { describe, expect, it } from "vitest";
import {
	overallOf,
	type Part,
	renderHealth,
} from "../../../../lib/web/audit/health.js";

const part = (
	kind: string,
	standing: Part["standing"],
	headline = "something",
): Part => ({ kind, standing, headline });

describe("overallOf", () => {
	it("lets one failure decide the whole digest", () => {
		expect(overallOf([part("a", "pass"), part("b", "fail")])).toBe("fail");
	});

	it("warns when nothing failed but something spoke up", () => {
		expect(overallOf([part("a", "pass"), part("b", "warn")])).toBe("warn");
	});

	it("passes only when everything did", () => {
		expect(overallOf([part("a", "pass")])).toBe("pass");
	});
});

describe("renderHealth", () => {
	it("says so when nothing ran", () => {
		expect(renderHealth([])).toContain("No checks were run");
	});

	it("names which checks failed rather than only how many", () => {
		const out = renderHealth([
			part("accessibility", "fail"),
			part("visual", "pass"),
			part("design", "fail"),
		]);
		expect(out).toContain("accessibility, design fail.");
	});

	it("uses the singular for one failing check", () => {
		expect(renderHealth([part("visual", "fail")])).toContain("visual fails.");
	});

	it("distinguishes nothing failing from everything passing", () => {
		const out = renderHealth([part("a", "pass"), part("b", "warn")]);
		expect(out).toContain("Nothing fails, but b raised something");
	});

	it("says everything checks out when it does", () => {
		expect(renderHealth([part("a", "pass")])).toContain(
			"Everything checks out",
		);
	});

	it("gives a line per check", () => {
		const out = renderHealth([part("keyboard", "pass", "all reachable")]);
		expect(out).toContain("all reachable");
	});

	it("reports a check that could not run rather than dropping it", () => {
		// A digest that quietly omits a check looks like coverage,
		// which is worse than admitting the gap.
		const out = renderHealth([
			part("visual", "pass"),
			{ ...part("perf", "warn"), failedToRun: "no observers" },
		]);
		expect(out).toContain("Ran 1 of 2 checks");
		expect(out).toContain("perf could not run");
	});

	it("counts plainly when every check ran", () => {
		expect(renderHealth([part("a", "pass"), part("b", "pass")])).toContain(
			"Ran 2 checks.",
		);
	});

	it("tells the reader how to get the detail", () => {
		expect(renderHealth([part("a", "pass")])).toContain("Name a kind");
	});
});

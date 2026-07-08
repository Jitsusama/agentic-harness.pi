import { describe, expect, it } from "vitest";
import {
	channelFor,
	IMMUNE_WINDOW,
	nextImmuneTurns,
	parseFindings,
} from "../../../extensions/advisor/findings.js";

describe("parseFindings", () => {
	it("parses findings with a known severity and claim", () => {
		const reply =
			'[{"severity":"concern","claim":"scope drift","evidence":"a.ts:10"}]';
		expect(parseFindings(reply)).toEqual([
			{ severity: "concern", claim: "scope drift", evidence: "a.ts:10" },
		]);
	});

	it("drops entries without a claim or a known severity", () => {
		const reply =
			'[{"severity":"concern","claim":""},{"severity":"loud","claim":"x"},{"severity":"aside","claim":"ok"}]';
		expect(parseFindings(reply)).toEqual([{ severity: "aside", claim: "ok" }]);
	});

	it("returns nothing when there is no array", () => {
		expect(parseFindings("no findings here")).toEqual([]);
		expect(parseFindings("[not json")).toEqual([]);
	});

	it("omits evidence when blank", () => {
		expect(
			parseFindings('[{"severity":"aside","claim":"c","evidence":"  "}]'),
		).toEqual([{ severity: "aside", claim: "c" }]);
	});
});

describe("channelFor", () => {
	it("keeps asides as asides regardless of back-off", () => {
		expect(channelFor("aside", 0)).toBe("aside");
		expect(channelFor("aside", 5)).toBe("aside");
	});

	it("interrupts for concerns and blockers when not immune", () => {
		expect(channelFor("concern", 0)).toBe("steer");
		expect(channelFor("blocker", 0)).toBe("steer");
	});

	it("softens interrupts to asides while immune", () => {
		expect(channelFor("concern", 1)).toBe("aside");
		expect(channelFor("blocker", 2)).toBe("aside");
	});
});

describe("nextImmuneTurns", () => {
	it("resets to the window when an interrupt fired", () => {
		expect(nextImmuneTurns(0, true)).toBe(IMMUNE_WINDOW);
	});

	it("decays toward zero otherwise", () => {
		expect(nextImmuneTurns(2, false)).toBe(1);
		expect(nextImmuneTurns(0, false)).toBe(0);
	});
});

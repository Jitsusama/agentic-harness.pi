import { describe, expect, it } from "vitest";
import {
	classifyCorrection,
	isoWeek,
} from "../../scripts/convention-recurrence.ts";

describe("classifyCorrection", () => {
	it("returns no category for ordinary prose", () => {
		expect(classifyCorrection("can you update the readme please")).toEqual([]);
	});

	it("flags an emdash complaint", () => {
		expect(classifyCorrection("stop using emdashes, I hate them")).toContain(
			"emdash",
		);
		expect(classifyCorrection("there is an — in the body")).toContain("emdash");
	});

	it("flags a Canadian-spelling correction", () => {
		expect(classifyCorrection("use Canadian spelling, not American")).toContain(
			"spelling",
		);
	});

	it("flags an invented-section correction", () => {
		expect(
			classifyCorrection("don't add new sections, use the ones it mentions"),
		).toContain("sections");
	});

	it("flags a Slack formatting correction", () => {
		expect(
			classifyCorrection("that should be a pipe table rendered as blocks"),
		).toContain("slack-format");
		expect(classifyCorrection("the numbered list is malformed")).toContain(
			"slack-format",
		);
	});

	it("flags a commit-format correction", () => {
		expect(
			classifyCorrection("the commit message should use imperative mood"),
		).toContain("commit");
	});

	it("can return more than one category at once", () => {
		const cats = classifyCorrection(
			"fix the emdashes and use Canadian spelling",
		);
		expect(cats).toContain("emdash");
		expect(cats).toContain("spelling");
	});
});

describe("isoWeek", () => {
	it("buckets a date into an ISO year-week label", () => {
		// 2026-05-31 is a Sunday in ISO week 22 of 2026.
		expect(isoWeek("2026-05-31T12:00:00Z")).toBe("2026-W22");
	});

	it("accepts an epoch-millisecond timestamp", () => {
		expect(isoWeek(Date.parse("2026-01-01T00:00:00Z"))).toMatch(
			/^\d{4}-W\d{2}$/,
		);
	});
});

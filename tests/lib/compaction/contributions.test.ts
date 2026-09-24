import { describe, expect, it } from "vitest";
import {
	isSummaryContributions,
	newContributions,
} from "../../../lib/compaction/index.ts";

describe("summary contributions", () => {
	it("starts empty and unhandled, naming the compaction it belongs to", () => {
		const preparation = {};
		const c = newContributions(preparation);
		expect(c).toEqual({
			preparation,
			instructions: [],
			appendix: [],
			handled: false,
		});
		expect(c.preparation).toBe(preparation);
	});

	it("recognises a request and nothing else", () => {
		expect(isSummaryContributions(newContributions({}))).toBe(true);
		expect(
			isSummaryContributions({
				instructions: [],
				appendix: [],
				handled: false,
			}),
		).toBe(false);
		expect(
			isSummaryContributions({
				preparation: {},
				instructions: "x",
				appendix: [],
				handled: false,
			}),
		).toBe(false);
		expect(isSummaryContributions(null)).toBe(false);
	});
});

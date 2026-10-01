import { describe, expect, it } from "vitest";
import {
	isSummaryContributions,
	newContributions,
	recordContribution,
} from "../../../lib/compaction/index.ts";

describe("summary contributions", () => {
	it("starts empty and unhandled, naming the compaction it belongs to", () => {
		const preparation = {};
		const c = newContributions(preparation);
		expect(c).toEqual({
			preparation,
			instructions: [],
			appendix: [],
			records: {},
			handled: false,
		});
		expect(c.preparation).toBe(preparation);
	});

	it("names where the verbatim tail starts once a compaction has chosen it", () => {
		expect(newContributions({}, "e7").firstKeptEntryId).toBe("e7");
		expect(newContributions({})).not.toHaveProperty("firstKeptEntryId");
	});

	it("keeps what each contributor did under its own id", () => {
		const c = newContributions({});
		recordContribution(c, "selection", { chosen: 3 });
		expect(c.records).toEqual({ selection: { chosen: 3 } });
	});

	it("records nothing, without failing, for a host from before records", () => {
		const older = {
			preparation: {},
			instructions: [],
			appendix: [],
			handled: false,
		};
		expect(isSummaryContributions(older)).toBe(true);
		if (!isSummaryContributions(older)) return;
		recordContribution(older, "selection", { chosen: 3 });
		expect(older).not.toHaveProperty("records");
	});

	it("recognises a request and nothing else", () => {
		expect(isSummaryContributions(newContributions({}, "e1"))).toBe(true);
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
		expect(
			isSummaryContributions({
				...newContributions({}),
				firstKeptEntryId: 3,
			}),
		).toBe(false);
		expect(isSummaryContributions(null)).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
import { accumulate, INITIAL_TOTALS } from "../../../lib/context/index.js";

describe("accumulating reclaimable totals across a session", () => {
	it("starts at zero", () => {
		expect(INITIAL_TOTALS).toEqual({ calls: 0, candidates: 0, chars: 0 });
	});

	it("adds one call and its findings to the running totals", () => {
		const next = accumulate(INITIAL_TOTALS, {
			candidates: [
				{ index: 0, toolCallId: "t1", toolName: "bash", chars: 500 },
			],
			totalChars: 500,
		});
		expect(next).toEqual({ calls: 1, candidates: 1, chars: 500 });
	});

	it("keeps accumulating across several calls without losing earlier ones", () => {
		let totals = INITIAL_TOTALS;
		totals = accumulate(totals, {
			candidates: [
				{ index: 0, toolCallId: "t1", toolName: "bash", chars: 100 },
			],
			totalChars: 100,
		});
		totals = accumulate(totals, { candidates: [], totalChars: 0 });
		totals = accumulate(totals, {
			candidates: [
				{ index: 0, toolCallId: "t2", toolName: "bash", chars: 50 },
				{ index: 1, toolCallId: "t3", toolName: "bash", chars: 75 },
			],
			totalChars: 125,
		});
		expect(totals).toEqual({ calls: 3, candidates: 3, chars: 225 });
	});
});

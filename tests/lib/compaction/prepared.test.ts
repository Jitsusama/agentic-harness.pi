import { describe, expect, it } from "vitest";
import { keptBoundary } from "../../../lib/compaction/index.ts";

const BRANCH = ["u1", "a1", "t1", "a2", "t2", "a3", "t3", "a4"];

describe("where the kept messages start for a summary written ahead", () => {
	it("keeps pi's usual verbatim tail when it starts before the summarised point", () => {
		// Summary covers up to t2; pi would keep from a2 on. Nothing after
		// t2 is summarised, and the overlap is the tail pi always keeps.
		expect(keptBoundary(BRANCH, "t2", "a2")).toEqual({
			ok: true,
			firstKeptEntryId: "a2",
		});
	});

	it("keeps everything after the summarised point when pi would cut later", () => {
		// Work went on while the summary was written: pi's cut at a4 would
		// drop a3 and t3, which the summary never saw.
		expect(keptBoundary(BRANCH, "t2", "a4")).toEqual({
			ok: true,
			firstKeptEntryId: "a3",
		});
	});

	it("uses pi's cut when nothing has happened since the summarised point", () => {
		expect(keptBoundary(BRANCH, "a4", "a3")).toEqual({
			ok: true,
			firstKeptEntryId: "a3",
		});
	});

	it("refuses a summary of a point the branch no longer passes through", () => {
		expect(keptBoundary(BRANCH, "elsewhere", "a3")).toEqual({
			ok: false,
			reason: "the summarised point is not on this branch",
		});
	});
});

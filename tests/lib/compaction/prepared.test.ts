import { describe, expect, it } from "vitest";
import {
	keptBoundary,
	pastCustomEntries,
} from "../../../lib/compaction/index.ts";

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

describe("keeping the verbatim tail off custom entries", () => {
	const branch = [
		{ id: "u1", type: "message" },
		{ id: "c1", type: "custom" },
		{ id: "c2", type: "custom" },
		{ id: "a1", type: "message" },
		{ id: "m1", type: "model_change" },
		{ id: "c3", type: "custom" },
	];

	it("starts at the next entry that is not a custom one", () => {
		expect(pastCustomEntries(branch, "c1")).toBe("a1");
	});

	it("leaves a boundary that is not a custom entry where it is", () => {
		expect(pastCustomEntries(branch, "u1")).toBe("u1");
		expect(pastCustomEntries(branch, "m1")).toBe("m1");
	});

	it("leaves it where it is when only custom entries follow, or it is not on the branch", () => {
		expect(pastCustomEntries(branch, "c3")).toBe("c3");
		expect(pastCustomEntries(branch, "gone")).toBe("gone");
	});
});

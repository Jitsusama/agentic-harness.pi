/**
 * The record a session leaves when something other than its person ends
 * its run, as a move back to plain pi does once it has waited long
 * enough on one: plain pi reads it and carries on (job-workflow
 * cut-off.ts).
 */
import { describe, expect, it } from "vitest";
import {
	CUT_OFF_ENTRY,
	cutByMove,
} from "../../../../lib/internal/session/cut-off-record.ts";

describe("a run a move ended", () => {
	it("is recorded as a run under way, saying what ended it, with no job dead", () => {
		expect(cutByMove("a move to plain pi", 7)).toEqual({
			at: 7,
			running: true,
			jobs: [],
			by: "a move to plain pi",
		});
	});

	it("is recorded under the entry plain pi reads on its return", () => {
		expect(CUT_OFF_ENTRY).toBe("job-session-cut-off");
	});
});

import { describe, expect, it } from "vitest";
import { statusLine } from "../../../extensions/job-workflow/lifecycle.ts";

/**
 * The footer's mark for background jobs.
 *
 * It read "jobs: 1 running, 2 waiting" on a line every extension shares
 * and nothing shortens. It is a mark now, shown only while a job runs.
 */

const theme = { fg: (colour: string, text: string) => `<${colour}>${text}` };

function jobs(...states: ("running" | "finished")[]) {
	return { list: () => states.map((state) => ({ state })) } as never;
}

describe("the jobs mark", () => {
	it("is absent with no jobs", () => {
		expect(statusLine(jobs(), theme)).toBeUndefined();
	});

	it("is absent when every job has finished and only waits to be said", () => {
		expect(statusLine(jobs("finished", "finished"), theme)).toBeUndefined();
	});

	it("is the hourglass alone for one running job", () => {
		expect(statusLine(jobs("running", "finished"), theme)).toBe(
			"<muted>\u29d7",
		);
	});

	it("counts running jobs once there is more than one", () => {
		expect(statusLine(jobs("running", "running", "finished"), theme)).toBe(
			"<muted>\u29d7 <dim>2",
		);
	});
});

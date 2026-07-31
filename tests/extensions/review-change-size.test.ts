/**
 * Saying how big a change is.
 *
 * `additions`, `deletions` and `changedFiles` sat on the contract with no
 * reader at all. Meteorite reads the API rather than the CLI largely to get
 * them, so they were fetched for every change and dropped on the floor, and
 * the first thing anybody wants to know about a change they have not read was
 * the one thing the line would not say.
 */

import { describe, expect, it } from "vitest";
import { proposalLine } from "../../extensions/review-integration/render.js";
import type { Proposal } from "../../lib/review/index.js";

function change(size: Partial<Proposal>): Proposal {
	return {
		ref: {
			label: "owner/repo#1",
			id: "1",
			provider: "github",
			repo: { key: "github:owner/repo" },
		},
		title: "Something",
		state: "open",
		author: { id: "someone" },
		head: "topic",
		base: "main",
		draft: false,
		...size,
	} as Proposal;
}

describe("stating the size of a change", () => {
	it("says files and lines when the provider reported them", async () => {
		const line = proposalLine(
			change({ changedFiles: 12, additions: 340, deletions: 21 }),
		);

		expect(line).toContain("12 files");
		expect(line).toContain("+340 -21");
	});

	it("says nothing at all when the provider reported nothing", async () => {
		// Absent means unreported, which is not the same as zero, and a
		// confident `0 files` about an unread change is worse than silence.
		const line = proposalLine(change({}));

		expect(line).not.toMatch(/files/);
		expect(line).not.toMatch(/\+0/);
	});

	it("reports the half it was given", async () => {
		const onlyFiles = proposalLine(change({ changedFiles: 3 }));
		expect(onlyFiles).toContain("3 files");
		expect(onlyFiles).not.toMatch(/\+/);

		const onlyLines = proposalLine(change({ additions: 5, deletions: 6 }));
		expect(onlyLines).toContain("+5 -6");
		expect(onlyLines).not.toMatch(/files/);
	});

	it("counts one file as a file", async () => {
		expect(proposalLine(change({ changedFiles: 1 }))).toContain("1 file");
		expect(proposalLine(change({ changedFiles: 1 }))).not.toContain("1 files");
	});

	it("keeps saying everything it said before", async () => {
		// The size rides alongside the rest of the line rather than replacing
		// any of it.
		const line = proposalLine(change({ changedFiles: 2 }));

		expect(line).toContain("owner/repo#1");
		expect(line).toContain("Something");
		expect(line).toContain("open");
		expect(line).toContain("topic");
		expect(line).toContain("main");
	});
});

/**
 * What a journal file is read to mean.
 *
 * Extracted from the supervisor so its rules could be held to one
 * answer, which is only true if something checks the answer. Both caps
 * matter more than they look: everything they refuse is a finding
 * somebody paid for, and the warning naming where it still sits is the
 * only trace it leaves.
 */

import { describe, expect, it } from "vitest";
import {
	JOURNAL_SAYS,
	journalWarnings,
	MAX_JOURNAL_ENTRIES,
	MAX_JOURNAL_ENTRY_BYTES,
	parseJournal,
} from "../../../../lib/subagent/runpi/journal.mjs";

/** One line of a journal, as the pack writes it. */
const line = (subject: string) => JSON.stringify({ subject });

describe("reading a journal back", () => {
	it("reads one object per line", () => {
		const counts = parseJournal(`${line("a")}\n${line("b")}\n`);

		expect(counts.entries).toEqual([{ subject: "a" }, { subject: "b" }]);
		expect(counts).toMatchObject({ dropped: 0, tooBig: 0, tooMany: 0 });
	});

	it("keeps every line above the one a kill landed on", () => {
		// The case the whole file exists for. A reviewer killed
		// mid-write leaves a half-written last line, and everything
		// above it is intact and paid for.
		const counts = parseJournal(`${line("kept")}\n{"subject": "cut off`);

		expect(counts.entries).toEqual([{ subject: "kept" }]);
		expect(counts.dropped).toBe(1);
	});

	it("ignores blank lines rather than counting them as damage", () => {
		const counts = parseJournal(`\n${line("a")}\n\n`);

		expect(counts.entries).toHaveLength(1);
		expect(counts.dropped).toBe(0);
	});

	it("refuses one entry larger than a finding should ever be", () => {
		// The journal is the only channel a reviewer controls that no
		// other cap touches, so a pasted file would ride to the parent
		// past every limit the stream has.
		const huge = JSON.stringify({
			subject: "x".repeat(MAX_JOURNAL_ENTRY_BYTES),
		});
		const counts = parseJournal(`${huge}\n${line("small")}`);

		expect(counts.entries).toEqual([{ subject: "small" }]);
		expect(counts.tooBig).toBe(1);
	});

	it("measures that cap in bytes, not in characters", () => {
		// A string's length is UTF-16 units, and a cap that means one
		// thing for prose and another for anything else is not a cap.
		// Just under the limit by characters, well over it by bytes.
		const wide = "\u{1F600}".repeat(MAX_JOURNAL_ENTRY_BYTES / 3);
		const counts = parseJournal(JSON.stringify({ subject: wide }));

		expect(counts.tooBig).toBe(1);
	});

	it("stops carrying entries past the limit and says how many", () => {
		const many = Array.from({ length: MAX_JOURNAL_ENTRIES + 3 }, (_, i) =>
			line(`finding ${i}`),
		).join("\n");

		const counts = parseJournal(many);

		expect(counts.entries).toHaveLength(MAX_JOURNAL_ENTRIES);
		expect(counts.tooMany).toBe(3);
	});
});

describe("saying what could not be carried", () => {
	it("says nothing when nothing was left behind", () => {
		expect(journalWarnings(parseJournal(line("a")), "/x")).toEqual([]);
	});

	it("names the file, since what it refused is still only there", () => {
		const said = journalWarnings(
			{ entries: [], dropped: 1, tooBig: 2, tooMany: 3 },
			"/runs/r/reviewers/hawk/journal.ndjson",
		);

		expect(said).toHaveLength(3);
		// Every one carries the marker the round selects these by, and
		// two of the three name where the findings still are.
		expect(said.every((one) => one.startsWith(JOURNAL_SAYS))).toBe(true);
		expect(said.filter((one) => one.includes("journal.ndjson"))).toHaveLength(
			2,
		);
	});
});

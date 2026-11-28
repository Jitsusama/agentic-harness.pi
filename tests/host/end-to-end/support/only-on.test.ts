/**
 * `itOnlyOn` as vitest itself runs it, where every-case-ran.test.ts holds
 * its body only to a fake context: a case naming another platform than
 * this one ends skipped, with its note and meta, and one naming this
 * platform runs its body. Both platforms are named by what runs this
 * file, so tests/package/code/host-cases-skip-only-off-linux.test.ts lets
 * this file's calls by.
 */

import { describe, expect, it } from "vitest";
import { itOnlyOn, onlyOnNote } from "./only-on.mts";

/** A platform other than the one running this file. */
const OTHER: NodeJS.Platform =
	process.platform === "linux" ? "darwin" : "linux";

/** The names of the two cases `itOnlyOn` registers below. */
const SKIPS = "skips on any platform but its own";
const RUNS = "runs on its own platform";

describe("itOnlyOn, run by vitest", () => {
	let ranElsewhere = false;
	let ranHere = false;

	itOnlyOn(OTHER, "it proves the skip")(SKIPS, () => {
		ranElsewhere = true;
	});

	itOnlyOn(process.platform, "it proves the run")(RUNS, () => {
		ranHere = true;
	});

	it("ended the other platform's case skipped, saying so, and ran this one's", ({
		task,
	}) => {
		const ended = (name: string) =>
			task.suite?.tasks.find((one) => one.name === name);
		const skipped = ended(SKIPS);
		// vitest keeps a skip's note on its result, though its type names none.
		expect(skipped?.result).toMatchObject({
			state: "skip",
			note: onlyOnNote(OTHER, "it proves the skip"),
		});
		expect(skipped?.meta).toEqual({
			onlyOn: OTHER,
			skippedOn: process.platform,
		});
		expect(ranElsewhere, "the skipped case's body").toBe(false);
		expect(ended(RUNS)?.result?.state).toBe("pass");
		expect(ranHere, "this platform's case's body").toBe(true);
	});
});

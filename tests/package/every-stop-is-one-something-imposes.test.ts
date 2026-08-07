/**
 * Every stop a reviewer can be recorded with is one something can
 * impose.
 *
 * A stop is not a small fact. It decides whether the reviewer is asked
 * for what it already had, whether a retry is refused as certain to
 * repeat, what the round tells a reader, and which knob the refusal
 * says to raise. An entry nobody can produce carries all of that
 * machinery for a case that never arrives, and the cost is not the
 * dead branch: it is that the machinery looks complete. The gap in
 * the retry refusal was filed as work to do, on a stop that could not
 * happen, and the fix would have been a budget for a limit nothing
 * enforces.
 *
 * The reachable set is small and comes from three places: the
 * watchdog's verdicts, the stops a signal or a departed parent
 * causes, and the one the adapter declares for a reviewer whose
 * supervisor is gone, which is the stop nothing inside a run can
 * report. This pins the mapping against it, both ways.
 *
 * Note what this is not about. The output caps are alive: they
 * truncate a reviewer's answer rather than stopping the reviewer,
 * which is a different event with a different remedy, and the stop
 * that was named after them was the leftover.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const source = (...parts: string[]) =>
	readFileSync(join(ROOT, ...parts), "utf8");

/** Every state named on the left of the reviewer's limit table. */
function mappedStates(): string[] {
	const text = source("extensions", "review-integration", "reviewer.ts");
	const table = /const LIMITS[^{]*{([\s\S]*?)\n};/.exec(text);
	if (table === null) throw new Error("the limit table has moved");
	const states = [...table[1].matchAll(/^\t"?([a-z-]+)"?:/gm)].map(
		(one) => one[1],
	);
	// Refused rather than returned. A scrape that reads nothing leaves
	// every loop below with nothing to check and every case green,
	// which is the one failure a gate must not have: it would report
	// the vocabulary sound at the moment it stopped looking at it.
	if (states.length < 4) {
		throw new Error(
			`the limit table reads as ${states.length} states, fewer than it has ever had`,
		);
	}
	return states;
}

/** Every stop something in the tree can actually cause. */
function imposedStates(): string[] {
	const watchdog = source("lib", "subagent", "runpi", "watchdog.mjs");
	const supervisor = source("lib", "subagent", "runpi", "supervisor.mjs");
	const adapter = source("extensions", "review-integration", "reviewer.ts");
	return [
		...[...watchdog.matchAll(/return "([a-z-]+)"/g)].map((one) => one[1]),
		...[...supervisor.matchAll(/stopChild\("([a-z-]+)"\)/g)].map(
			(one) => one[1],
		),
		...[...adapter.matchAll(/state: "([a-z-]+)"/g)].map((one) => one[1]),
	];
}

describe("the stops a reviewer can be recorded with", () => {
	it("are all stops something in the tree can impose", () => {
		// Each source matched on how it imposes rather than on naming
		// the state, or the table would satisfy itself: one of the three
		// files is the one the table lives in.
		const imposed = new Set(imposedStates());

		for (const state of mappedStates()) {
			expect({ state, imposed: imposed.has(state) }).toEqual({
				state,
				imposed: true,
			});
		}
	});

	it("cover every stop something imposes, which is the costly direction", () => {
		// The other way round, and the one that loses work rather than
		// merely carrying a dead branch. A state nothing maps reads as a
		// reviewer that was not stopped at all, so what it had is never
		// asked for, a retry is never refused, and the round files a
		// working reviewer as a failure.
		const mapped = new Set(mappedStates());

		for (const state of new Set(imposedStates())) {
			expect({ state, mapped: mapped.has(state) }).toEqual({
				state,
				mapped: true,
			});
		}
	});
});

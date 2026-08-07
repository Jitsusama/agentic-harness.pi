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
 * The reachable set is small and named in one place: the watchdog's
 * verdicts, plus the stops a signal or a departed parent causes. This
 * pins the mapping against it.
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
	return [...table[1].matchAll(/^\t"?([a-z-]+)"?:/gm)].map((one) => one[1]);
}

describe("the stops a reviewer can be recorded with", () => {
	it("are all stops something in the tree can impose", () => {
		// Three sources, and each is matched on how it imposes rather
		// than on naming the state, or the table would satisfy itself:
		// the watchdog returns a verdict, the supervisor stops its child
		// on a signal or a departed parent, and the adapter declares a
		// state for the reviewer whose supervisor is no longer there,
		// which is the one stop nothing inside the run can report.
		const watchdog = source("lib", "subagent", "runpi", "watchdog.mjs");
		const supervisor = source("lib", "subagent", "runpi", "supervisor.mjs");
		const adapter = source("extensions", "review-integration", "reviewer.ts");

		for (const state of mappedStates()) {
			const imposed =
				watchdog.includes(`return "${state}"`) ||
				supervisor.includes(`stopChild("${state}")`) ||
				adapter.includes(`state: "${state}"`);
			expect({ state, imposed }).toEqual({ state, imposed: true });
		}
	});

	it("does not carry the output cap that was taken out", () => {
		// Measured rather than reasoned: the caps this named were
		// removed when a large review was moved onto a file, and the
		// state outlived them. Nothing has ever written it, so nothing
		// on disk can be read back as it either.
		for (const file of [
			join("lib", "subagent", "artifacts.ts"),
			join("lib", "subagent", "subagent.ts"),
			join("lib", "subagent", "runpi", "supervisor.mjs"),
			join("extensions", "review-integration", "reviewer.ts"),
		]) {
			expect(source(file)).not.toContain("output-limit");
		}
	});
});

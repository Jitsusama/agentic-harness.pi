/**
 * The host gate's reporter, on the cases a run ended with: it names each
 * that skipped, with its note, and nothing that passed or failed.
 */
import { describe, expect, it } from "vitest";
import { skipsIn } from "./every-case-ran.mts";

/** A file whose cases ended as given. */
function file(
	moduleId: string,
	cases: readonly { name: string; state: string; note?: string }[],
) {
	return {
		moduleId,
		children: {
			*allTests() {
				for (const { name, state, note } of cases)
					yield {
						fullName: name,
						result: () => (note === undefined ? { state } : { state, note }),
					};
			},
		},
	};
}

describe("skipsIn", () => {
	it("names each skipped case with its file and its note", () => {
		expect(
			skipsIn([
				file("engine.test.ts", [
					{ name: "opens", state: "passed" },
					{ name: "resumes", state: "skipped", note: "No pi built" },
				]),
				file("screens.test.ts", [{ name: "hands off", state: "skipped" }]),
			]),
		).toEqual([
			"engine.test.ts: resumes: No pi built",
			"screens.test.ts: hands off: skipped, saying nothing of why",
		]);
	});

	it("names a file from the root it is given", () => {
		expect(
			skipsIn(
				[
					file("/repo/tests/host/parity/parity.test.ts", [
						{ name: "tool", state: "skipped", note: "No pi built" },
					]),
				],
				"/repo",
			),
		).toEqual(["tests/host/parity/parity.test.ts: tool: No pi built"]);
	});

	it("finds nothing when every case ran", () => {
		expect(
			skipsIn([
				file("parity.test.ts", [
					{ name: "tool", state: "passed" },
					{ name: "abort", state: "failed" },
				]),
			]),
		).toEqual([]);
	});
});

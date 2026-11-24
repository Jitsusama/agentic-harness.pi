import { describe, expect, it } from "vitest";
import { SAID_COMMAND, saidFrom } from "../../../lib/mesh/said-to.ts";

const SINCE = Date.parse("2026-11-24T00:00:00Z");

/** One thing said, as `mycelium said` writes it. */
function line(said: Record<string, unknown>): string {
	return JSON.stringify({ kind: "said", machine: "optimus", ...said });
}

describe("what the person said to sessions", () => {
	it("asks the node the one way the surfaces table names", () => {
		expect(SAID_COMMAND).toEqual(["said"]);
	});

	it("says how each stands: answered, being worked on, not taken up, or put in a prompt", () => {
		const listing = [
			line({
				address: "A",
				at: "2026-11-24T10:00:00Z",
				text: "one",
				taken_up: "x",
				answered: "y",
			}),
			line({
				address: "B",
				at: "2026-11-24T11:00:00Z",
				text: "two",
				taken_up: "x",
			}),
			line({ address: "C", at: "2026-11-24T12:00:00Z", text: "three" }),
			line({
				address: "D",
				at: "2026-11-24T13:00:00Z",
				text: "four",
				act: "fill",
			}),
		].join("\n");

		expect(
			saidFrom(listing, SINCE, 10).map((one) => [one.address, one.standing]),
		).toEqual([
			["D", "put in its prompt"],
			["C", "not taken up"],
			["B", "working"],
			["A", "answered"],
		]);
	});

	it("keeps only what was said since, the newest few", () => {
		const listing = [
			line({ address: "OLD", at: "2026-11-23T23:59:59Z", text: "old" }),
			line({ address: "A", at: "2026-11-24T01:00:00Z", text: "a" }),
			line({ address: "B", at: "2026-11-24T02:00:00Z", text: "b" }),
			line({ address: "C", at: "2026-11-24T03:00:00Z", text: "c" }),
		].join("\n");

		expect(saidFrom(listing, SINCE, 2).map((one) => one.address)).toEqual([
			"C",
			"B",
		]);
	});

	it("holds what he said to one line, and skips what is no such thing", () => {
		const listing = [
			line({
				address: "A",
				at: "2026-11-24T01:00:00Z",
				text: "first\n\nAttached:\n- window",
			}),
			"{torn",
			line({ at: "2026-11-24T01:00:00Z", text: "to nobody" }),
			line({ address: "B", at: "whenever", text: "no time" }),
		].join("\n");

		const said = saidFrom(listing, SINCE, 10);

		expect(said.map((one) => one.address)).toEqual(["A"]);
		expect(said[0]?.text).not.toContain("\n");
		expect(said[0]?.machine).toBe("optimus");
	});
});

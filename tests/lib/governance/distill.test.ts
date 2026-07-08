import { describe, expect, it } from "vitest";
import {
	condenseTranscript,
	parseRules,
	type Turn,
} from "../../../lib/governance/distill.js";

describe("condenseTranscript", () => {
	it("labels turns by role and drops empty ones", () => {
		const turns: Turn[] = [
			{ role: "user", text: "do X" },
			{ role: "assistant", text: "  " },
			{ role: "assistant", text: "done" },
		];
		const out = condenseTranscript(turns);
		expect(out).toBe("USER: do X\n\nASSISTANT: done");
	});

	it("keeps the most recent turns when over the cap", () => {
		const turns: Turn[] = [
			{ role: "user", text: "oldest oldest oldest" },
			{ role: "user", text: "newest" },
		];
		const out = condenseTranscript(turns, 20);
		expect(out).toContain("newest");
		expect(out).not.toContain("oldest");
	});
});

describe("parseRules", () => {
	it("parses a bare JSON array", () => {
		expect(parseRules('["keep breadth", "ground claims"]')).toEqual([
			"keep breadth",
			"ground claims",
		]);
	});

	it("extracts a JSON array wrapped in prose", () => {
		const reply = 'Here are the rules:\n["one", "two"]\nThat is all.';
		expect(parseRules(reply)).toEqual(["one", "two"]);
	});

	it("recovers the array despite a trailing bracket in prose", () => {
		const reply =
			'Here are the rules: ["Always test.", "Never force push."]. See issue [123].';
		expect(parseRules(reply)).toEqual(["Always test.", "Never force push."]);
	});

	it("falls back to bullet and numbered lines", () => {
		const reply = "- first rule\n2. second rule\n* third";
		expect(parseRules(reply)).toEqual(["first rule", "second rule", "third"]);
	});

	it("drops empty strings from the JSON array", () => {
		expect(parseRules('["a", "", "  ", "b"]')).toEqual(["a", "b"]);
	});
});

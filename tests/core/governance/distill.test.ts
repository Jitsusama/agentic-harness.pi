import { describe, expect, it } from "vitest";
import {
	condenseTranscript,
	parseRules,
	type Turn,
} from "../../../lib/core/governance/distill.ts";

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

	it("gives what dropping the oldest turns one at a time gives, at every cap", () => {
		const words = [
			"a",
			"  ",
			"fix the test",
			"",
			" keep it short ",
			"x".repeat(40),
		];
		const turns: Turn[] = Array.from({ length: 30 }, (_, at) => ({
			role: at % 3 === 0 ? "assistant" : "user",
			text: `${words[at % words.length]}${at % 4 === 1 ? "" : ` ${at}`}`,
		}));
		const blank = turns.flatMap((t, at) => (t.text.trim() ? [] : [at]));
		expect(blank, "the turns a condense leaves out").toEqual([
			1, 9, 13, 21, 25,
		]);
		const whole = droppingOldest(turns, Number.POSITIVE_INFINITY).length;

		for (let cap = 0; cap <= whole + 1; cap++) {
			for (const from of [0, 7, 29]) {
				const some = turns.slice(from);
				expect(condenseTranscript(some, cap)).toBe(droppingOldest(some, cap));
			}
		}
		expect(condenseTranscript([], 10)).toBe("");
	});

	it("reads only the turns it keeps and the one that would not fit", () => {
		const read: number[] = [];
		const turns: Turn[] = Array.from({ length: 1_000 }, (_, at) => ({
			role: "user",
			get text() {
				read.push(at);
				return `turn ${at} of the session`;
			},
		}));

		const out = condenseTranscript(turns, 100);

		const kept = out.split("\n\n").length;
		expect(kept).toBe(3);
		expect(read).toEqual([999, 998, 997, 996]);
	});
});

/** The transcript as it was condensed before, by dropping the oldest turn until it fits. */
function droppingOldest(turns: readonly Turn[], maxChars: number): string {
	const lines = turns
		.filter((t) => t.text.trim().length > 0)
		.map(
			(t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text.trim()}`,
		);
	let transcript = lines.join("\n\n");
	while (transcript.length > maxChars && lines.length > 1) {
		lines.shift();
		transcript = lines.join("\n\n");
	}
	if (transcript.length > maxChars) {
		transcript = transcript.slice(transcript.length - maxChars);
	}
	return transcript;
}

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

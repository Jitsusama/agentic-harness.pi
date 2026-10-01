import { describe, expect, it } from "vitest";
import { RESUME_TEXT } from "../../../../lib/compaction/resume.ts";
import { paragraphsOf } from "../../../../lib/compaction/selection/paragraphs.ts";
import { unitsOf } from "../../../../lib/compaction/selection/units.ts";
import { assistant, compaction, user } from "./fixtures.ts";

describe("paragraphsOf", () => {
	it("splits on blank lines and trims", () => {
		expect(paragraphsOf("one\nstill one\n\n\n  two  \n")).toEqual([
			"one\nstill one",
			"two",
		]);
	});

	it("keeps a fenced block whole across its blank lines", () => {
		const text = "before\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter";
		expect(paragraphsOf(text)).toEqual([
			"before",
			"```ts\nconst a = 1;\n\nconst b = 2;\n```",
			"after",
		]);
	});
});

describe("unitsOf", () => {
	it("reads the text a user typed, a paragraph at a time", () => {
		const units = unitsOf(
			user("u1", "Never push straight to main.\n\nAlways sign commits."),
		);
		expect(units.map((u) => [u.text, u.speaker, u.index])).toEqual([
			["Never push straight to main.", "user", 0],
			["Always sign commits.", "user", 1],
		]);
	});

	it("reads an assistant's text and not its thinking or tool calls", () => {
		const units = unitsOf(assistant("a1", "The build fails on the lockfile."));
		expect(units.map((u) => u.text)).toEqual([
			"The build fails on the lockfile.",
		]);
	});

	it("gives the same paragraph the same hash whatever its spacing", () => {
		const [a] = unitsOf(user("u1", "Always sign  commits."));
		const [b] = unitsOf(user("u2", "Always sign\ncommits."));
		expect(a?.hash).toBe(b?.hash);
	});

	it("leaves out paragraphs too short or too long to quote", () => {
		const long = "x".repeat(2001);
		expect(
			unitsOf(user("u1", `ok\n\n${long}\n\nA paragraph worth keeping.`)).map(
				(u) => u.text,
			),
		).toEqual(["A paragraph worth keeping."]);
	});

	it("leaves out the harness's resume messages and entries that are not messages", () => {
		expect(
			unitsOf(user("u1", `${RESUME_TEXT}\n\nQuest context here.`)),
		).toEqual([]);
		expect(unitsOf(compaction("c1"))).toEqual([]);
	});
});

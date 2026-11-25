import { describe, expect, it } from "vitest";
import { RESUME_TEXT } from "../../../../lib/compaction/resume.ts";
import { kindsFor } from "../../../../lib/compaction/selection/kinds.ts";
import { paragraphsOf } from "../../../../lib/compaction/selection/paragraphs.ts";
import { unitsOf } from "../../../../lib/compaction/selection/units.ts";
import {
	automatedText,
	START_WORDS_REASON,
} from "../../../../lib/internal/automated.ts";
import { spawnedWords } from "../../../../lib/internal/quest/sessions/first-words.ts";
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

	it("never quotes a turn the harness started as something a person said", () => {
		const report =
			"[Automated message, no human input: background jobs are reporting.]\n\n" +
			"[job j1] A paragraph long enough that it would otherwise be worth keeping.";
		expect(unitsOf(user("u1", report))).toEqual([]);
		expect(
			unitsOf(
				user(
					"u2",
					"Verification found 3 errors in files you changed this turn.\n\nA paragraph long enough to keep.",
				),
			),
		).toEqual([]);
	});

	// A sprout's ask is in the words its start left it, marked so no log
	// reads them as the person's; dropped, a compaction lost the ask.
	it("quotes the words a session's start left it as the start's, never a person's", () => {
		const words = automatedText(
			START_WORDS_REASON,
			'Quest QEST-1 is made for "tidy the rows".\n\nTie it to the map.',
		);
		const units = unitsOf(user("u1", words));
		expect(units.map((u) => [u.text, u.speaker])).toEqual([
			['Quest QEST-1 is made for "tidy the rows".', "start"],
			["Tie it to the map.", "start"],
		]);
	});

	// A quest spawn's words say what its session was started for, as a
	// sprout's do; those it sends into a session it reopens don't.
	it("quotes a quest spawn's words as the start's, unless it reopened the session", () => {
		const started = unitsOf(
			user("u1", spawnedWords("QEST-1", "Tidy the drawer's rows.")),
		);
		expect(started.map((u) => u.speaker)).toEqual(["start", "start", "start"]);
		expect(started.at(-1)?.text).toBe("Tidy the drawer's rows.");
		const reopened = unitsOf(
			user("u2", spawnedWords("QEST-1", "Tidy the drawer's rows.", true)),
		);
		expect(reopened).toEqual([]);
	});

	it("lets a start's words give the ask, as only the person's can besides", () => {
		expect(kindsFor("start")).toContain("goal");
		expect(kindsFor("user")).toContain("goal");
		expect(kindsFor("assistant")).not.toContain("goal");
	});
});

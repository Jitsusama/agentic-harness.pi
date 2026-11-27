/**
 * A session the host parked for a roll is told of it once, when a pi
 * next starts on it: on 27 November rolled sessions read as cut off,
 * each starting again with no word of the roll.
 */

import type {
	CustomEntry,
	CustomMessageEntry,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { LOADED_MESSAGE } from "../../../../lib/internal/reload/loaded.ts";
import {
	ROLLED_ENTRY,
	rolledText,
	rollToTell,
} from "../../../../lib/internal/reload/rolled.ts";
import { assistant, user } from "../../compaction/selection/fixtures.ts";

const FROM = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const ONTO = "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678";
const AT = "2026-11-27T10:12:00.000Z";
const NOW = "agentic-harness.pi runs its install at 16c71561.";

let ids = 0;

/** What the host writes of a roll, as most cases here need it. */
const ROLL = { from: FROM, onto: ONTO, at: AT };

/**
 * The entry the host leaves as it parks a conversation for a roll,
 * holding `data` as written, an undefined one included.
 */
function rolledEntry(...given: [unknown?]) {
	const data = given.length === 0 ? ROLL : given[0];
	ids += 1;
	const entry: CustomEntry = {
		type: "custom",
		id: `r${ids}`,
		parentId: null,
		timestamp: AT,
		customType: ROLLED_ENTRY,
		data,
	};
	return entry;
}

/** A note on which code runs, as the reload workflow leaves one. */
function loadedNote(): SessionEntry {
	ids += 1;
	const entry: CustomMessageEntry = {
		type: "custom_message",
		id: `n${ids}`,
		parentId: null,
		timestamp: AT,
		customType: LOADED_MESSAGE,
		content: NOW,
		display: false,
	};
	return entry;
}

/** The person's clock, fixed so the text can be read. */
const clock = () => "05:12";

describe("the roll a session's log owes it word of", () => {
	it("is the host's roll, with what the session last said", () => {
		const roll = rollToTell([
			user("u1", "fix the fence"),
			assistant("a1", "Running the fence tests next."),
			rolledEntry(),
		]);
		expect(roll?.rolled, "the roll was missed").toEqual({
			from: FROM,
			onto: ONTO,
			at: AT,
			wakes: false,
		});
		expect(roll?.lastWords, "the last words were missed").toBe(
			"Running the fence tests next.",
		);
	});

	it("says the host wakes the session only when the entry says so", () => {
		const roll = rollToTell([
			rolledEntry({ from: FROM, onto: ONTO, at: AT, wakes: true }),
		]);
		expect(roll?.rolled.wakes, "a waking roll read as quiet").toBe(true);
	});

	it("quotes the session's own last words, past what reached it", () => {
		const roll = rollToTell([
			assistant("a1", "Earlier words."),
			assistant("a2", "Waiting on the host test."),
			user("u2", "a mesh message"),
			rolledEntry(),
		]);
		expect(roll?.lastWords, "older words were quoted").toBe(
			"Waiting on the host test.",
		);
	});

	it("is nothing once a pi on the new code said what runs", () => {
		expect(
			rollToTell([rolledEntry(), loadedNote()]),
			"a roll was told twice",
		).toBeUndefined();
	});

	it("is nothing once the session carried on", () => {
		expect(
			rollToTell([rolledEntry(), user("u1", "hi"), assistant("a1", "On it.")]),
			"a session that already spoke was told of a stale roll",
		).toBeUndefined();
	});

	it("is the newest roll when the host rolled the session twice", () => {
		const newest = { from: ONTO, onto: FROM, at: AT };
		const roll = rollToTell([rolledEntry(), rolledEntry(newest)]);
		expect(roll?.rolled.onto, "an older roll was told").toBe(FROM);
	});

	it("is nothing in a log the host never rolled", () => {
		expect(
			rollToTell([user("u1", "hi"), assistant("a1", "Hello.")]),
			"a session never rolled was told of a roll",
		).toBeUndefined();
	});

	it("is nothing for an entry not written as a roll", () => {
		for (const data of [
			undefined,
			"rolled",
			{ from: FROM, onto: ONTO },
			{ from: FROM, onto: ONTO, at: "not a time" },
			{ from: 1, onto: ONTO, at: AT },
		]) {
			expect(
				rollToTell([rolledEntry(data)]),
				`a malformed entry was told: ${JSON.stringify(data)}`,
			).toBeUndefined();
		}
	});
});

describe("what a rolled session is told", () => {
	it("says when, onto what, what runs, its last words, and to carry on", () => {
		const text = rolledText(
			{
				rolled: { from: FROM, onto: ONTO, at: AT, wakes: false },
				lastWords: "Running the fence tests next.",
			},
			NOW,
			clock,
		);
		expect(text, "the time was left out").toContain("at 05:12");
		expect(text, "the new code was left out").toContain("host 1a2b3c4d");
		expect(text, "the old code was left out").toContain("from 9f8e7d6c");
		expect(text, "what runs was left out").toContain(NOW);
		expect(text, "the last words were left out").toContain(
			'"Running the fence tests next."',
		);
		expect(text, "it didn't say to carry on").toMatch(
			/Carry on from where you were\.$/,
		);
	});

	it("cuts long last words and leaves out none it never had", () => {
		const long = rolledText(
			{
				rolled: { from: FROM, onto: ONTO, at: AT, wakes: false },
				lastWords: "word ".repeat(200).trim(),
			},
			NOW,
			clock,
		);
		expect(long.length, "long last words were quoted whole").toBeLessThan(800);
		expect(long, "a cut quote didn't say so").toContain('..."');
		const none = rolledText(
			{
				rolled: { from: FROM, onto: ONTO, at: AT, wakes: false },
				lastWords: undefined,
			},
			NOW,
			clock,
		);
		expect(none, "missing last words were quoted").not.toContain("last said");
	});
});

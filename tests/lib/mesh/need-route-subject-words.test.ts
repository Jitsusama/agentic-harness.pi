/**
 * The words a cell's declared subjects give it: each subject read by its
 * narrowest part, and capped so no cell can stuff its record. How a need
 * is routed by those words is need-route-subjects.test.ts's.
 */

import { describe, expect, it } from "vitest";
import {
	foragersFrom,
	LONGEST_WORD,
	MOST_SUBJECT_WORDS,
	routingWords,
	subjectWords,
} from "../../../lib/mesh/need-route.ts";
import { MOST_SUBJECTS } from "../../../lib/mesh/subjects.ts";

describe("the words a cell's declared subjects give it", () => {
	it("reads the narrowest part of each subject a cell declares, beside its title", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "cell:5HJZ8Z",
					title: "Carry a Session",
					subjects: ["mycelium:easing", "health.asks.", 12345],
				},
				{ key: "cell:9T2BBY", title: "Placement", subjects: "easing" },
			],
		});

		expect(foragersFrom(line)).toEqual([
			{ address: "5HJZ8Z", words: ["carry", "session", "easing", "asks"] },
			{ address: "9T2BBY", words: ["placement"] },
		]);
	});

	it("never gives a cell the broader words of a subject it narrows", () => {
		expect(subjectWords("mycelium:easing")).toEqual(["easing"]);
		expect(subjectWords("unit:pi-host-")).toEqual(["host", "pi-host"]);
		expect(subjectWords("health.asks.")).toEqual(["asks"]);
		expect(subjectWords("")).toEqual([]);
	});

	it("breaks a subject at a slash, as a repository's scope does", () => {
		expect(subjectWords("github:Jitsusama/mycelium")).toEqual(["mycelium"]);
	});

	it("reads at most MOST_SUBJECTS subjects from one cell", () => {
		// Every subject within the cap says the same word, so only the cap
		// on subjects, not the one on their words, leaves the last unread.
		const subjects = [
			...Array.from({ length: MOST_SUBJECTS }, (_, at) => `same${at}:easing`),
			"past:carry",
		];
		const line = JSON.stringify({
			id: 2,
			records: [{ key: "cell:XXXXXX", subjects }],
		});

		const [cell] = foragersFrom(line);

		expect(cell?.words, "the subject past the cap is not read").toEqual([
			"easing",
		]);
	});

	it("reads every one of MOST_SUBJECTS subjects, the last included", () => {
		// One word over and over, then another in the last place, so the
		// last is read only if the non-string before them took no place,
		// whatever MOST_SUBJECT_WORDS holds the words to.
		const subjects = [
			...Array.from({ length: MOST_SUBJECTS - 1 }, () => "x:zorbic"),
			"x:quuxly",
		];
		const line = JSON.stringify({
			id: 2,
			records: [{ key: "cell:XXXXXX", subjects: [5, ...subjects] }],
		});

		const [cell] = foragersFrom(line);

		expect(cell?.words, "a non-string takes no subject's place").toEqual([
			"zorbic",
			"quuxly",
		]);
	});

	it("gives a word a subject shares with the title once, as the title's", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "cell:XXXXXX",
					title: "Carry a Session",
					subjects: ["mycelium:carry", "mycelium:easing"],
				},
			],
		});

		const [cell] = foragersFrom(line);

		expect(cell?.words).toEqual(["carry", "session", "easing"]);
	});

	it("gives a cell at most MOST_SUBJECT_WORDS words from all its subjects together", () => {
		const half = MOST_SUBJECT_WORDS / 2 + 1;
		const run = (from: number) =>
			Array.from({ length: half }, (_, at) => `word${from + at}`);
		const subject = (from: number) => `x:${run(from).join("-")}`;
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "cell:XXXXXX",
					title: "Placement",
					subjects: [subject(0), subject(half)],
				},
			],
		});

		const [cell] = foragersFrom(line);

		expect(
			cell?.words,
			"its title, then the first subject words up to the cap, across subjects",
		).toEqual(
			["placement", ...run(0), ...run(half)].slice(0, 1 + MOST_SUBJECT_WORDS),
		);
		expect(
			cell?.words,
			"no id longer than a route keeps, as each joined run of words is",
		).not.toContain(run(0).join("-"));
	});

	it("routes by a subject word as long as LONGEST_WORD, and none longer", () => {
		const longest = "p".repeat(LONGEST_WORD);

		expect(routingWords(`x:${longest}`), "at the cap").toEqual([longest]);
		expect(routingWords(`x:${longest}p`), "past it").toEqual([]);
		expect(subjectWords(`x:${longest}p`), "still the subject's").toEqual([
			`${longest}p`,
		]);
	});

	it("spends none of a cell's MOST_SUBJECT_WORDS on a word no need keeps", () => {
		const long = "p".repeat(LONGEST_WORD + 1);
		const run = Array.from(
			{ length: MOST_SUBJECT_WORDS },
			(_, at) => `word${at}`,
		);
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "cell:XXXXXX",
					title: "Placement",
					subjects: [`x:${long}`, `x:${run.join("-")}`],
				},
			],
		});

		const [cell] = foragersFrom(line);

		expect(cell?.words, "every short word, the long one left out").toEqual([
			"placement",
			...run,
		]);
	});

	it("counts a subject's ids apart from its words, so an id pushes no word out", () => {
		const words = Array.from(
			{ length: MOST_SUBJECT_WORDS },
			(_, at) => `${String.fromCharCode(97 + at).repeat(3)}`,
		);
		const half = MOST_SUBJECT_WORDS / 2;
		const first = words.slice(0, half).join("-");
		const second = words.slice(half).join("-");
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "cell:ROWS01",
					subjects: [`x:${first}`, `x:${second}`],
				},
			],
		});
		const [cell] = foragersFrom(line);

		expect(cell?.words, "every word of both subjects, then both ids").toEqual([
			...words.slice(0, half),
			first,
			...words.slice(half),
			second,
		]);
	});
});

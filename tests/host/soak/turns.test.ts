/**
 * The soak's script tells every conversation the same things on every
 * run, mixes in each kind of turn, falls into visits of two to eight
 * turns, and stops every conversation at each checkpoint the same share
 * of the way through.
 */
import { describe, expect, it } from "vitest";
import {
	acknowledged,
	asked,
	checkpointsOf,
	turnsOf,
	visitsOf,
} from "./turns.ts";

describe("the soak's turns", () => {
	it("are the same on every run, each tagged once", () => {
		const turns = turnsOf(3, 40);
		expect(turns, "the script doesn't change between runs").toEqual(
			turnsOf(3, 40),
		);
		expect(
			new Set(turns.map((turn) => turn.tag)).size,
			"no tag repeats",
		).toBe(40);
	});

	it("ask for every kind of turn, mostly echoes", () => {
		const kinds = turnsOf(0, 34).map((turn) => turn.kind);
		expect(new Set(kinds), "each kind comes up").toEqual(
			new Set(["echo", "read", "bash", "job", "long"]),
		);
		expect(
			kinds.filter((kind) => kind === "echo").length,
			"most turns echo",
		).toBeGreaterThan(kinds.length / 2);
	});

	it("say their tag and kind in words the provider reads back", () => {
		for (const turn of turnsOf(2, 20))
			expect(asked(turn.prompt), turn.prompt).toEqual({
				tag: turn.tag,
				kind: turn.kind,
			});
		expect(asked("hello there"), "other words aren't the soak's").toBe(
			undefined,
		);
	});

	it("end on an acknowledgement no longer tag contains", () => {
		expect(
			acknowledged("c1-t50").includes(acknowledged("c1-t5")),
			"c1-t5's ending isn't found in c1-t50's",
		).toBe(false);
	});
});

describe("the soak's visits", () => {
	it("cover every turn once, in order, two to eight at a time", () => {
		const turns = turnsOf(1, 101);
		const visits = visitsOf(turns);
		expect(
			visits.flatMap((visit) => visit.turns),
			"every turn, once, in order",
		).toEqual(turns);
		for (const visit of visits.slice(0, -1))
			expect(visit.turns.length, "a visit's length").toBeGreaterThanOrEqual(2);
		expect(
			Math.max(...visits.map((visit) => visit.turns.length)),
			"the longest visit",
		).toBeLessThanOrEqual(8);
	});

	it("have a second viewer join every third visit", () => {
		const joined = visitsOf(turnsOf(0, 60)).map((visit) => visit.joined);
		expect(joined.slice(0, 6), "the third and sixth join").toEqual([
			false,
			false,
			true,
			false,
			false,
			true,
		]);
	});
});

describe("the soak's checkpoints", () => {
	it("fall the same share of the way through every conversation, the last at its end", () => {
		expect(checkpointsOf(120, 4), "the busiest").toEqual([30, 60, 90, 120]);
		expect(checkpointsOf(40, 4), "a quieter one").toEqual([10, 20, 30, 40]);
		expect(checkpointsOf(40, 0), "none asked for").toEqual([]);
	});
});

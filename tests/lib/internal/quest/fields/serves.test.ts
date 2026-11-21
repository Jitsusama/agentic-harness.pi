/**
 * The needs a quest's cell took, read and added as mycelium's node reads
 * a cell's `serves`: an entry it would pass over is passed over here.
 */
import { describe, expect, it } from "vitest";
import {
	MOST_SERVED,
	needAsker,
	servedFrom,
	withServed,
} from "../../../../../lib/internal/quest/fields/serves.ts";

const taken = {
	cell: "IKQ63G",
	need: "I-5 fails at the candidate",
	since: "2026-11-21T11:00:00.000Z",
};

/** A need's id as the mesh mints one, asked by `asker`. */
const needOf = (asker: string, tail = "0123456789ab") =>
	`${asker}/mh3k2a1.${tail}`;

describe("the needs a quest's README says it took", () => {
	it("reads none from anything that isn't a list", () => {
		expect(servedFrom(undefined), "nothing said reads as none").toEqual([]);
		expect(servedFrom("IKQ63G"), "a word reads as none").toEqual([]);
		expect(
			servedFrom({ ...taken }),
			"one entry unlisted reads as none",
		).toEqual([]);
	});

	it("puts a need on one line and cuts it at the node's length", () => {
		const [read] = servedFrom([
			{ ...taken, need: `  first\n\tsecond  ${"x".repeat(400)}` },
		]);

		expect(read?.need.startsWith("first second x"), "it is one line").toBe(
			true,
		);
		expect([...(read?.need ?? "")].length, "it is cut at 280").toBe(280);
	});

	it("keeps a need's id only when it is one the mesh mints, of the same cell", () => {
		const id = needOf("IKQ63G");

		expect(servedFrom([{ ...taken, id }])[0]?.id, "its own need's id").toBe(id);
		expect(
			servedFrom([{ ...taken, id: needOf("ikq63g") }])[0]?.id,
			"its own need's id in another case",
		).toBe(needOf("ikq63g"));
		for (const [why, other] of [
			["no id", ""],
			["not a need's id", "IKQ63G/1.ab"],
			["another cell's need", needOf("TERN02")],
			["a need's id with more after it", `${id}x`],
		]) {
			expect(servedFrom([{ ...taken, id: other }])[0], why).not.toHaveProperty(
				"id",
			);
		}
	});

	it("refuses a time with no offset, which the node can't read", () => {
		expect(
			servedFrom([{ ...taken, since: "2026-11-21T11:00:00" }]),
			"a time with no offset is passed over",
		).toEqual([]);
	});

	it(`keeps the newest ${MOST_SERVED}, the last listed`, () => {
		const many = Array.from({ length: MOST_SERVED + 3 }, (_, n) => ({
			...taken,
			need: `need ${n}`,
		}));
		const read = servedFrom(many);

		expect(read, "it keeps no more than the node does").toHaveLength(
			MOST_SERVED,
		);
		expect(read[0]?.need, "the oldest three are let go").toBe("need 3");
		expect(read.at(-1)?.need, "the newest is kept").toBe(
			`need ${MOST_SERVED + 2}`,
		);
	});
});

describe("a need added to those a quest took", () => {
	it("adds a need not yet listed", () => {
		expect(withServed([], taken), "the new need is listed").toEqual([taken]);
	});

	it("adds nothing for the same words from the same cell when either has no id", () => {
		const later = { ...taken, since: "2026-11-22T11:00:00.000Z" };

		expect(withServed([taken], later), "the first stays alone").toBeUndefined();
		expect(
			withServed([{ ...taken, cell: "ikq63g" }], later),
			"a cell is the same in any case",
		).toBeUndefined();
	});

	it("adds a second need from the same cell in the same words, told apart by its id", () => {
		const first = { ...taken, id: needOf("IKQ63G", "0123456789ab") };
		const second = { ...taken, id: needOf("IKQ63G", "ba9876543210") };

		expect(withServed([first], second), "both needs are listed").toEqual([
			first,
			second,
		]);
		expect(
			withServed([first], { ...first, need: "other words" }),
			"the same id is the same need",
		).toBeUndefined();
	});

	it("adds nothing the node would pass over", () => {
		expect(
			withServed([taken], { ...taken, cell: "not an address" }),
			"an address with a space adds nothing",
		).toBeUndefined();
	});

	it("keeps what was there as written, a hand's entry and its keys included", () => {
		const hand = {
			cell: "TERN02",
			need: "by hand",
			since: "2026-11-20",
			note: 1,
		};
		const added = withServed([hand], taken);

		expect(
			added,
			"the hand's entry stays as written, the new after it",
		).toEqual([hand, taken]);
	});

	it("lets the oldest go once full, keeping the newest", () => {
		const full = Array.from({ length: MOST_SERVED }, (_, n) => ({
			...taken,
			need: `need ${n}`,
		}));
		const added = withServed(full, { ...taken, need: "the newest" }) ?? [];

		expect(added, "it stays at the node's count").toHaveLength(MOST_SERVED);
		expect(servedFrom(added).at(-1)?.need, "the newest is kept").toBe(
			"the newest",
		);
		expect(servedFrom(added)[0]?.need, "the oldest is let go").toBe("need 1");
	});
});

describe("the asker a need's id names", () => {
	it("is the id's first part, for an id as the mesh mints one", () => {
		expect(needAsker(needOf("TERN02")), "its first part names the asker").toBe(
			"TERN02",
		);
	});

	it("is none for anything else", () => {
		for (const said of ["TERN02", "TERN02/1.ab", "a b/mh3k2a1.0123456789ab"]) {
			expect(needAsker(said), `${said} is no need's id`).toBeUndefined();
		}
	});
});

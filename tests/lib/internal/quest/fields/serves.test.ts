/**
 * The needs a quest's cell took, read and added as mycelium's node reads
 * a cell's `serves`: an entry it would pass over is passed over here.
 */
import { describe, expect, it } from "vitest";
import {
	MOST_SERVED,
	servedFrom,
	withServed,
} from "../../../../../lib/internal/quest/fields/serves.ts";

const taken = {
	cell: "IKQ63G",
	need: "I-5 fails at the candidate",
	since: "2026-11-21T11:00:00.000Z",
};

describe("the needs a quest's README says it took", () => {
	it("reads none from anything that isn't a list", () => {
		expect(servedFrom(undefined), "nothing said").toEqual([]);
		expect(servedFrom("IKQ63G"), "a word").toEqual([]);
		expect(servedFrom({ ...taken }), "one entry, unlisted").toEqual([]);
	});

	it("puts a need on one line and cuts it at the node's length", () => {
		const [read] = servedFrom([
			{ ...taken, need: `  first\n\tsecond  ${"x".repeat(400)}` },
		]);

		expect(read?.need.startsWith("first second x"), "one line").toBe(true);
		expect([...(read?.need ?? "")].length, "cut at 280").toBe(280);
	});

	it("keeps a need's id beside it only when it says one", () => {
		expect(
			servedFrom([{ ...taken, id: " IKQ63G/1.ab " }])[0]?.id,
			"trimmed id",
		).toBe("IKQ63G/1.ab");
		expect(servedFrom([{ ...taken, id: "" }])[0], "no id").not.toHaveProperty(
			"id",
		);
	});

	it("refuses a time with no offset, which the node can't read", () => {
		expect(
			servedFrom([{ ...taken, since: "2026-11-21T11:00:00" }]),
			"no offset",
		).toEqual([]);
	});

	it(`keeps at most ${MOST_SERVED}`, () => {
		const many = Array.from({ length: MOST_SERVED + 3 }, (_, n) => ({
			...taken,
			need: `need ${n}`,
		}));

		expect(servedFrom(many), "capped").toHaveLength(MOST_SERVED);
	});
});

describe("a need added to those a quest took", () => {
	it("adds a need not yet listed", () => {
		expect(withServed([], taken), "the new need").toEqual([taken]);
	});

	it("leaves the list as it was for the same need from the same cell", () => {
		const later = { ...taken, since: "2026-11-22T11:00:00.000Z" };

		expect(withServed([taken], later), "listed once, first time kept").toEqual([
			taken,
		]);
	});

	it("adds nothing the node would pass over", () => {
		expect(
			withServed([taken], { ...taken, cell: "not an address" }),
			"an address with a space",
		).toEqual([taken]);
	});

	it("keeps the newest once full", () => {
		const full = Array.from({ length: MOST_SERVED }, (_, n) => ({
			...taken,
			need: `need ${n}`,
		}));
		const added = withServed(full, { ...taken, need: "the newest" });

		expect(added, "still capped").toHaveLength(MOST_SERVED);
		expect(added.at(-1)?.need, "the newest kept").toBe("the newest");
		expect(added[0]?.need, "the oldest let go").toBe("need 1");
	});
});

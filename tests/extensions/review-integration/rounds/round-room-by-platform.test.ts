/**
 * A round reads the room its platform has: a Mac the queue's swap rule,
 * spaced two minutes apart, and Linux its pressure and available memory
 * with no spacing of its own. A start that waited past an unread Mac
 * says so in what the round answers.
 */

import { describe, expect, it } from "vitest";
import {
	MAC_SPACING_MS,
	roundRoom,
	withUnjudged,
} from "../../../../extensions/review-integration/tools/ask-round.ts";
import type { RoundRoom } from "../../../../lib/core/review/ask/memory-room.ts";

const macRoom: RoundRoom = {
	short: async () => "a Mac's own reason",
	startedUnjudged: () => "started without a verdict",
};

describe("the room a round reads", () => {
	it("is the Mac's rule on a Mac, spaced two minutes apart", async () => {
		const room = roundRoom("darwin", () => macRoom);

		expect(await room.short()).toBe("a Mac's own reason");
		expect(room.startedUnjudged()).toBe("started without a verdict");
		expect(room.spacingMs).toBe(MAC_SPACING_MS);
		expect(MAC_SPACING_MS).toBe(2 * 60_000);
	});

	it("is Linux's own reading off a Mac, with no spacing of its own", () => {
		let asked = false;
		const room = roundRoom("linux", () => {
			asked = true;
			return macRoom;
		});

		expect(room.spacingMs).toBeUndefined();
		expect(room.startedUnjudged()).toBeUndefined();
		expect(asked, "a Linux round never builds the Mac's room").toBe(false);
	});
});

describe("a start that waited past an unjudged Mac", () => {
	it("says the wait after what the line already said", () => {
		const start = withUnjudged({ waited: "It waited 3 minutes." }, "unread");

		expect(start.waited).toBe("It waited 3 minutes. unread");
	});

	it("says it alone when the line said nothing", () => {
		expect(withUnjudged({}, "unread").waited).toBe("unread");
	});

	it("leaves the start as it was when it was judged", () => {
		const start = { waited: "It waited 3 minutes." };

		expect(withUnjudged(start, undefined)).toBe(start);
	});
});

/**
 * A round reads the room its platform has: a Mac the queue's swap rule,
 * spaced two minutes apart, and Linux its memory and CPU pressure and
 * available memory with no spacing of its own. A start that waited past an unread Mac
 * says so in what the round answers.
 */

import { describe, expect, it } from "vitest";
import {
	MAC_SPACING_MS,
	roundRoom,
	spacingAtLeast,
	withUnjudged,
} from "../../../../extensions/review-integration/tools/ask-round.ts";
import type { RoundRoom } from "../../../../lib/core/review/ask/mac-room.ts";

const macRoom: RoundRoom = {
	short: async () => "a Mac's own reason",
	startedUnjudged: () => "started without a verdict",
};

describe("the room a round reads", () => {
	it("is the Mac's rule on a Mac, spaced two minutes apart", async () => {
		const room = roundRoom(
			"darwin",
			() => macRoom,
			async () => undefined,
		);

		expect(await room.short()).toEqual({
			said: "a Mac's own reason",
			readings: ["the Mac's memory"],
			passable: false,
		});
		expect(room.startedUnjudged()).toBe("started without a verdict");
		expect(room.spacingMs).toBe(MAC_SPACING_MS);
		expect(MAC_SPACING_MS).toBe(2 * 60_000);
		expect(room.quiet, "a Mac reads no quiet").toBeUndefined();
	});

	// 26 November: two rounds started side by side on the work Mac twice
	// in ten minutes, each on a reading the other had yet to spend.
	it("waits on a Mac while another roster round still runs there, before reading its memory", async () => {
		let read = false;
		const room = roundRoom(
			"darwin",
			() => ({
				...macRoom,
				short: async () => {
					read = true;
					return undefined;
				},
			}),
			async () => "council-x still runs on this Mac",
		);

		expect(await room.short()).toEqual({
			said: "council-x still runs on this Mac",
			readings: ["another round on this Mac"],
			passable: false,
		});
		expect(read, "a round already running needs no reading").toBe(false);
	});

	it("is Linux's own reading off a Mac, with no spacing and no wait for other rounds", async () => {
		let asked = false;
		let runningAsked = false;
		const room = roundRoom(
			"linux",
			() => {
				asked = true;
				return macRoom;
			},
			async () => {
				runningAsked = true;
				return "another round";
			},
		);

		expect(room.spacingMs).toBeUndefined();
		expect(room.quiet, "Linux reads whether it is quiet").toBeDefined();
		expect(room.startedUnjudged()).toBeUndefined();
		expect(asked, "a Linux round never builds the Mac's room").toBe(false);
		await room.short();
		expect(runningAsked, "Linux runs rounds side by side").toBe(false);
	});
});

// The council of 27 November: a startSpacingMinutes of one replaced the
// Mac's two minutes, which the README said a config couldn't do.
describe("the spacing a round keeps on a machine with its own", () => {
	it("never goes under the machine's own, whatever the config sets", async () => {
		const configured = async () => 60_000;
		expect(await spacingAtLeast(configured, MAC_SPACING_MS)()).toBe(
			MAC_SPACING_MS,
		);
	});

	it("keeps the machine's own where the config sets none", async () => {
		const none = async () => undefined;
		expect(await spacingAtLeast(none, MAC_SPACING_MS)()).toBe(MAC_SPACING_MS);
	});

	it("takes a wider spacing the config sets", async () => {
		const wide = async () => 10 * 60_000;
		expect(await spacingAtLeast(wide, MAC_SPACING_MS)()).toBe(10 * 60_000);
	});

	it("is the config's alone on a machine with none of its own", async () => {
		const none = async () => undefined;
		expect(await spacingAtLeast(none, undefined)()).toBeUndefined();
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

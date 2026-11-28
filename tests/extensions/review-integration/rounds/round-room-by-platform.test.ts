/**
 * A round reads the room its platform has: a Mac the queue's swap rule,
 * spaced as far apart as a round takes to settle in, and Linux its memory and CPU pressure and
 * available memory with no spacing of its own. A Mac starts as many
 * roster rounds at once as its config allows, one unless it says more,
 * and a further one only beside rounds settled in, on a reading with
 * room for it. A start that waited past an unread Mac says so in what
 * the round answers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { macRoundsAtOnce } from "../../../../extensions/review-integration/roster.ts";
import {
	type RunningRound,
	SETTLED_AFTER_MS,
} from "../../../../extensions/review-integration/round-running.ts";
import {
	MAC_SPACING_MS,
	roundRoom,
	spacingAtLeast,
	withUnjudged,
} from "../../../../extensions/review-integration/tools/ask-round.ts";
import type { RoundRoom } from "../../../../lib/core/review/ask/mac-room.ts";
import { packageConfigPath } from "../../../../lib/internal/paths.ts";

const macRoom: RoundRoom = {
	short: async () => "a Mac's own reason",
	startedUnjudged: () => "started without a verdict",
	freePercent: async () => 95,
};

/** No roster round running on this machine. */
const none = async (): Promise<readonly RunningRound[]> => [];

/** One roster round running, `minutes` in. */
function oneFor(minutes: number): () => Promise<readonly RunningRound[]> {
	return async () => [
		{ runId: "council-x", reviewersRunning: 2, runningMs: minutes * 60_000 },
	];
}

/** A config's `review.mac.roundsAtOnce` of `said`, as a round reads it. */
function atOnce(said: unknown): () => Promise<number> {
	return async () => macRoundsAtOnce({ roundsAtOnce: said });
}

/** A Mac reading `free`% free, whose own bar finds room. */
function roomyMacAt(free: number): { room: RoundRoom; looked: () => boolean } {
	let looked = false;
	return {
		room: {
			...macRoom,
			short: async () => {
				looked = true;
				return undefined;
			},
			freePercent: async () => free,
		},
		looked: () => looked,
	};
}

describe("the room a round reads", () => {
	it("is the Mac's rule on a Mac, spaced as far apart as a round takes to settle in", async () => {
		const room = roundRoom("darwin", () => macRoom, none, atOnce(undefined));

		expect(await room.short()).toEqual({
			said: "a Mac's own reason",
			readings: ["the Mac's memory"],
			passable: false,
		});
		expect(room.startedUnjudged()).toBe("started without a verdict");
		expect(room.spacingMs).toBe(MAC_SPACING_MS);
		// A closer start could pass beside a round whose reviewers had yet
		// to load (F1, F11, F13).
		expect(MAC_SPACING_MS, "the spacing is the settle time").toBe(
			SETTLED_AFTER_MS,
		);
	});

	it("marks a Mac's start until its folder shows it, and no Linux start", () => {
		const mark = async () => async () => undefined;
		const mac = roundRoom("darwin", () => macRoom, none, atOnce(1), mark);
		const linux = roundRoom("linux", () => macRoom, none, atOnce(1), mark);
		expect(mac.markStart).toBe(mark);
		expect(linux.markStart).toBeUndefined();
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
			oneFor(30),
			atOnce(undefined),
		);

		expect(await room.short()).toEqual({
			said: "council-x still runs on this Mac (2 of its reviewers are still running, 30 minutes in), and a Mac starts one roster round at a time",
			readings: ["another round on this Mac"],
			passable: false,
		});
		expect(read, "a round already running needs no reading").toBe(false);
	});

	it("starts a second round at two at once beside one 5 minutes in, with 70% free, on the Mac's own bar", async () => {
		const mac = roomyMacAt(70);
		const room = roundRoom("darwin", () => mac.room, oneFor(5), atOnce(2));

		expect(await room.short()).toBeUndefined();
		expect(mac.looked(), "the 35% bar and swap rule still judge it").toBe(true);
	});

	it("holds a second round at two at once beside one 1 minute in", async () => {
		const mac = roomyMacAt(95);
		const room = roundRoom("darwin", () => mac.room, oneFor(1), atOnce(2));

		const held = await room.short();

		expect(held?.readings).toEqual(["another round on this Mac"]);
		expect(held?.said).toContain("council-x has run 1 minute on this Mac");
		expect(mac.looked()).toBe(false);
	});

	it("holds a second round at two at once with 50% free, on the Mac's memory", async () => {
		const mac = roomyMacAt(50);
		const room = roundRoom("darwin", () => mac.room, oneFor(5), atOnce(2));

		const held = await room.short();

		expect(held?.readings).toEqual(["the Mac's memory"]);
		expect(held?.said).toContain("this Mac reads 50% free");
		expect(held?.passable).toBe(false);
	});

	it("holds a third round at two at once while two run", async () => {
		const mac = roomyMacAt(95);
		const two = async (): Promise<readonly RunningRound[]> => [
			{ runId: "council-b", reviewersRunning: 1, runningMs: 10 * 60_000 },
			{ runId: "council-a", reviewersRunning: 3, runningMs: 40 * 60_000 },
		];
		const room = roundRoom("darwin", () => mac.room, two, atOnce(2));

		const held = await room.short();

		expect(held?.readings).toEqual(["another round on this Mac"]);
		expect(held?.said).toContain("starts at most 2 at a time");
	});

	describe("reading roundsAtOnce from the package config", () => {
		let home: string;
		beforeEach(() => {
			home = mkdtempSync(join(tmpdir(), "rounds-at-once-"));
			vi.stubEnv("XDG_CONFIG_HOME", home);
		});
		afterEach(() => {
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		});

		/** The package config holding `review` as its review section. */
		function configHolds(review: unknown): void {
			mkdirSync(dirname(packageConfigPath()), { recursive: true });
			writeFileSync(
				packageConfigPath(),
				JSON.stringify({ version: 1, sections: { review } }),
			);
		}

		it("starts a second beside one settled in where review.mac says 2", async () => {
			configHolds({ mac: { roundsAtOnce: 2 } });
			const mac = roomyMacAt(95);

			const room = roundRoom("darwin", () => mac.room, oneFor(30));

			expect(await room.short()).toBeUndefined();
		});

		it("holds one at a time where it sits outside review.mac, or the config says nothing", async () => {
			for (const review of [{ roundsAtOnce: 2 }, { mac: {} }, undefined]) {
				configHolds(review);
				const room = roundRoom("darwin", () => roomyMacAt(95).room, oneFor(30));

				expect((await room.short())?.said, JSON.stringify(review)).toContain(
					"a Mac starts one roster round at a time",
				);
			}
		});
	});

	it("reads a bad roundsAtOnce as one, holding a second beside one settled in with room", async () => {
		for (const bad of ["two", 0, -2, 1.5, Number.NaN, null, undefined]) {
			const mac = roomyMacAt(95);
			const room = roundRoom("darwin", () => mac.room, oneFor(30), atOnce(bad));

			const held = await room.short();

			expect(held?.said, String(bad)).toContain(
				"a Mac starts one roster round at a time",
			);
		}
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
				return [{ runId: "council-x", reviewersRunning: 1 }];
			},
			atOnce(undefined),
		);

		expect(room.spacingMs).toBeUndefined();
		expect(room.startedUnjudged()).toBeUndefined();
		expect(asked, "a Linux round never builds the Mac's room").toBe(false);
		await room.short();
		expect(runningAsked, "Linux runs rounds side by side").toBe(false);
	});
});

describe("how many roster rounds a Mac's config lets run at once", () => {
	it("is the whole number it sets, one or more", () => {
		expect(macRoundsAtOnce({ roundsAtOnce: 2 })).toBe(2);
		expect(macRoundsAtOnce({ roundsAtOnce: 1 })).toBe(1);
	});

	it("is one where it sets none, or no review.mac at all", () => {
		expect(macRoundsAtOnce({})).toBe(1);
		expect(macRoundsAtOnce(undefined)).toBe(1);
		expect(macRoundsAtOnce("two")).toBe(1);
	});

	it("is one for a value that isn't a whole number of at least one", () => {
		for (const bad of [
			"2",
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			true,
		]) {
			expect(macRoundsAtOnce({ roundsAtOnce: bad }), String(bad)).toBe(1);
		}
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

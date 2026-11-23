import { afterEach, describe, expect, it } from "vitest";
import {
	holdForMove,
	letMoveGo,
	MOVE_HOLDS_MOST_MS,
	moveWaiting,
} from "../../../../lib/internal/session/move-waiting.ts";

const one = "01a1ecbb-0000-7000-8000-0000000e3011";
const other = "01a1ecbb-0000-7000-8000-0000000e3012";

afterEach(() => {
	letMoveGo(one);
	letMoveGo(other);
});

describe("a move's hold on its session's reload", () => {
	it("holds from when it is taken until the move lets go", () => {
		expect(moveWaiting(one)).toBe(undefined);
		holdForMove(one, "background");
		expect(moveWaiting(one)).toBe("background");
		letMoveGo(one);
		expect(moveWaiting(one)).toBe(undefined);
	});

	it("holds each session apart, as a host's conversations share a process", () => {
		holdForMove(one, "background");
		expect(moveWaiting(other)).toBe(undefined);
		holdForMove(other, "pi");
		letMoveGo(one);
		expect([moveWaiting(one), moveWaiting(other)]).toEqual([undefined, "pi"]);
	});

	// A move whose looks stopped never keeps a reload off for long.
	it("lapses by itself once the move has stopped renewing it", () => {
		let now = 1_000;
		holdForMove(one, "background", { now: () => now });
		now += MOVE_HOLDS_MOST_MS - 1;
		expect(moveWaiting(one, { now: () => now })).toBe("background");
		now += 1;
		expect(moveWaiting(one, { now: () => now })).toBe(undefined);
	});

	it("lasts from its latest renewal", () => {
		let now = 1_000;
		holdForMove(one, "background", { now: () => now });
		now += MOVE_HOLDS_MOST_MS - 1;
		holdForMove(one, "background", { now: () => now });
		now += MOVE_HOLDS_MOST_MS - 1;
		expect(moveWaiting(one, { now: () => now })).toBe("background");
	});
});

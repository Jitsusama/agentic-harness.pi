import { afterEach, describe, expect, it } from "vitest";
import {
	holdForMove,
	letMoveGo,
	MOVE_HOLDS_MOST_MS,
	moveHolder,
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

	// F167: a session that changes while its move waits (a new
	// conversation or a fork) leaves no hold on the old one's reload.
	it("lets go of the session a window's move held once its session changes", () => {
		const holder = moveHolder();
		holder.hold(one, "background");
		holder.hold(other, "background");
		expect(
			[moveWaiting(one), moveWaiting(other)],
			"the old one let go, the new one held",
		).toEqual([undefined, "background"]);
	});

	it("lets go of the session it held at a stop, and holds nothing with no session", () => {
		const holder = moveHolder();
		holder.hold(undefined, "background");
		holder.hold(one, "background");
		holder.hold(undefined, "background");
		expect(moveWaiting(one), "a peer naming none keeps the hold").toBe(
			"background",
		);
		holder.letGo();
		expect(moveWaiting(one)).toBe(undefined);
		holdForMove(other, "pi");
		holder.letGo();
		expect(moveWaiting(other), "another's own hold stays").toBe("pi");
	});

	it("renews the hold of the session it holds", () => {
		let now = 1_000;
		const holder = moveHolder({ now: () => now });
		holder.hold(one, "background");
		now += MOVE_HOLDS_MOST_MS - 1;
		holder.hold(one, "background");
		now += MOVE_HOLDS_MOST_MS - 1;
		expect(moveWaiting(one, { now: () => now })).toBe("background");
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

/**
 * Move from outside a session's window: it ends the first moment
 * nothing of its own is out, leaving the note its move is taken up by.
 */
import { describe, expect, it, vi } from "vitest";
import {
	createMoving,
	MOVE_LOOK_MS,
	type MovingSession,
} from "../../../extensions/mesh-workflow/moving.ts";
import type { MoveTarget } from "../../../lib/internal/session/move.ts";
import type { Moving } from "../../../lib/mesh/presence.ts";

interface Session {
	holds: string | undefined;
	moving: Moving | undefined;
	noteFails: boolean;
	readonly move: MovingSession;
	readonly did: string[];
	readonly told: string[];
	/** Who each close or release said asked for it. */
	readonly asked: string[];
	readonly said: (Moving | undefined)[];
	/** The look the clock would make, while one is set. */
	tick?: () => void;
	readonly clocks: number[];
}

function session(
	holds?: string,
	hosted = false,
	release?: () => Promise<boolean>,
): Session {
	const at: Session = {
		holds,
		moving: undefined,
		noteFails: false,
		did: [],
		told: [],
		asked: [],
		said: [],
		clocks: [],
		move: createMoving({
			holds: () => at.holds,
			hosted: () => hosted,
			moving: () => at.moving,
			setMoving: (now) => {
				at.moving = now;
				at.said.push(now);
			},
			note: (to: MoveTarget) => {
				if (at.noteFails) throw new Error("the disk is full");
				at.did.push(`note ${to}`);
			},
			tell: (text) => at.told.push(text),
			close: (by) => {
				at.did.push("close");
				at.asked.push(`close by ${by}`);
			},
			...(release
				? {
						release: (by: string) => {
							at.did.push("release");
							at.asked.push(`release by ${by}`);
							return release();
						},
					}
				: {}),
			now: () => new Date("2026-11-10T09:00:00.000Z"),
			every: (ms, look) => {
				at.clocks.push(ms);
				at.tick = look;
				return () => {
					at.tick = undefined;
				};
			},
		}),
	};
	return at;
}

describe("moving a session", () => {
	it("ends a free session at once, its note written before it closes", () => {
		const one = session();
		one.move.move("background");
		expect(one.did).toEqual(["note background", "close"]);
		expect(one.told.at(-1)).toMatch(/moving to the background host/);
		expect(one.said[0]).toEqual({
			to: "background",
			since: "2026-11-10T09:00:00.000Z",
		});
	});

	it("waits out what holds it, saying so, and ends once nothing does", () => {
		const one = session("background jobs are out");
		one.move.move("attended");
		expect(one.did).toEqual([]);
		expect(one.moving).toEqual({
			to: "attended",
			since: "2026-11-10T09:00:00.000Z",
			holds: "background jobs are out",
		});
		expect(one.clocks).toEqual([MOVE_LOOK_MS]);
		one.holds = "a run is under way";
		one.tick?.();
		expect(one.moving?.holds).toBe("a run is under way");
		one.holds = undefined;
		one.tick?.();
		expect(one.did).toEqual(["note attended", "close"]);
		expect(one.tick).toBeUndefined();
	});

	it("says what holds it only when that changes", () => {
		const one = session("a prompt is open");
		one.move.move("attended");
		const said = one.said.length;
		one.move.look();
		one.move.look();
		expect(one.said.length).toBe(said);
	});

	it("is called off when the person is at the desk, and looks no more", () => {
		const one = session("text is typed and unsent");
		one.move.move("background");
		one.move.cancel();
		expect(one.moving).toBeUndefined();
		expect(one.tick).toBeUndefined();
		expect(one.told.at(-1)).toMatch(/The move is off/);
		one.holds = undefined;
		one.move.look();
		expect(one.did).toEqual([]);
	});

	it("calls off nothing when no move waits", () => {
		const one = session();
		one.move.cancel();
		expect(one.told).toEqual([]);
		expect(one.said).toEqual([]);
	});

	it("stays open, saying why, when its note can't be written", () => {
		const one = session();
		one.noteFails = true;
		one.move.move("background");
		expect(one.did).toEqual([]);
		expect(one.moving).toBeUndefined();
		expect(one.told.at(-1)).toMatch(/couldn't move.*stays open.*disk is full/);
	});

	it("goes on with a move a reload carried, once looked at", () => {
		const one = session("a run is under way");
		one.moving = { to: "background", since: "2026-11-10T08:00:00.000Z" };
		one.move.look();
		expect(one.clocks).toEqual([MOVE_LOOK_MS]);
		one.holds = undefined;
		one.tick?.();
		expect(one.did).toEqual(["note background", "close"]);
	});

	it("moves a hosted conversation to plain pi, and no pi to where it is", () => {
		const hosted = session(undefined, true);
		hosted.move.move("pi");
		expect(hosted.did).toEqual(["note pi", "close"]);
		const plain = session();
		plain.move.move("pi");
		expect(plain.did).toEqual([]);
		expect(plain.moving).toBeUndefined();
		expect(plain.told.at(-1)).toMatch(/runs in plain pi already/);
	});

	it("lets a hosted conversation go through its host, closing it only when the host made no release", async () => {
		const released = session(undefined, true, async () => true);
		released.move.move("pi");
		// Past the release's answer, when a refused one would close it.
		await new Promise((settled) => setImmediate(settled));
		expect(released.did).toEqual(["note pi", "release"]);
		for (const failing of [
			async () => false,
			async () => {
				throw new Error("the host went");
			},
		]) {
			const refused = session(undefined, true, failing);
			refused.move.move("pi");
			await vi.waitFor(() =>
				expect(refused.did).toEqual(["note pi", "release", "close"]),
			);
		}
	});

	it("moves to a host by closing, though it could be released", () => {
		const one = session(undefined, true, async () => true);
		one.move.move("background");
		expect(one.did).toEqual(["note background", "close"]);
	});

	it("says the move as it closes or releases, for its host's journal", async () => {
		const closed = session(undefined, true, async () => true);
		closed.move.move("background");
		expect(closed.asked).toEqual([
			"close by a move to the background host, asked from outside its window",
		]);

		const refused = session(undefined, true, async () => false);
		refused.move.move("pi");
		await vi.waitFor(() =>
			expect(refused.asked, "the close after a refused release").toEqual([
				"release by a move to plain pi, asked from outside its window",
				"close by a move to plain pi, asked from outside its window",
			]),
		);
	});

	it("says a move asked in its own window as asked there", () => {
		const one = session();
		one.move.move("background", "here");
		expect(one.told[0]).toBe(
			"Moving to the background host in this window, once nothing of its own is out.",
		);
		expect(one.asked).toEqual([
			"close by a move to the background host, asked in its window",
		]);
	});

	it("says what a move asked in its own window waits for first", () => {
		const one = session("a run is under way");
		one.move.move("attended", "here");
		expect(one.told).toEqual([
			"Moving to the attended host in this window; waiting first, as a run is under way.",
		]);
		expect(one.did).toEqual([]);
	});

	it("ends once, however often it is asked after", () => {
		const one = session();
		one.move.move("background");
		one.move.move("attended");
		one.move.look();
		expect(one.did).toEqual(["note background", "close"]);
	});
});

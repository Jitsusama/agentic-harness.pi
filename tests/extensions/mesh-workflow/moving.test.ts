/**
 * Move from outside a session's window: it ends the first moment
 * nothing of its own is out, leaving the note its move is taken up by.
 */
import { describe, expect, it } from "vitest";
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
	readonly said: (Moving | undefined)[];
	/** The look the clock would make, while one is set. */
	tick?: () => void;
	readonly clocks: number[];
}

function session(holds?: string, hosted = false): Session {
	const at: Session = {
		holds,
		moving: undefined,
		noteFails: false,
		did: [],
		told: [],
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
			close: () => at.did.push("close"),
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

	it("ends once, however often it is asked after", () => {
		const one = session();
		one.move.move("background");
		one.move.move("attended");
		one.move.look();
		expect(one.did).toEqual(["note background", "close"]);
	});
});

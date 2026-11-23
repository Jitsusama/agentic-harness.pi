/**
 * Move from outside a session's window: it ends the first moment
 * nothing of its own is out, leaving the note its move is taken up by.
 */
import {
	createEventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createMoving,
	holdsOf,
	MOVE_LOOK_MS,
	MOVE_WAIT_MOST_MS,
	type MovingSession,
	RELEASE_WAIT_MS,
} from "../../../extensions/mesh-workflow/moving.ts";
import { holdForCarry } from "../../../lib/internal/carry/under-way.ts";
import type { MoveTarget } from "../../../lib/internal/session/move.ts";
import { announceJobHost, type JobHold } from "../../../lib/jobs/index.ts";
import type { MoveOff, Moving } from "../../../lib/mesh/moving.ts";

const ASKED = Date.parse("2026-11-10T09:00:00.000Z");

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
	/** Why each move it called off went, as its presence says. */
	readonly offs: MoveOff[];
	/** What each run it ended said ended it. */
	readonly cuts: string[];
	/** Each hold on its reload it renewed, and each time it let go. */
	readonly reloads: string[];
	/** Its clock, in ms since the epoch. */
	time: number;
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
		offs: [],
		cuts: [],
		reloads: [],
		time: ASKED,
		clocks: [],
		move: createMoving({
			holds: () => at.holds,
			hosted: () => hosted,
			moving: () => at.moving,
			setMoving: (now) => {
				at.moving = now;
				at.said.push(now);
			},
			calledOff: (off) => {
				at.moving = undefined;
				at.offs.push(off);
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
			cutRun: (by) => at.cuts.push(by),
			holdReloads: (to) => at.reloads.push(`hold for ${to}`),
			letReloadsGo: () => at.reloads.push("let go"),
			...(release
				? {
						release: (by: string) => {
							at.did.push("release");
							at.asked.push(`release by ${by}`);
							return release();
						},
					}
				: {}),
			now: () => new Date(at.time),
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
	// A reload going as the run settles stops a waiting move unwritten;
	// E30 failed so under a full host test's load on 23 November.
	it("holds its session's reload at every look while it waits, and lets go as it is called off", () => {
		const one = session("a run is under way");
		one.move.move("background");
		one.tick?.();
		expect(one.reloads).toEqual([
			"hold for background",
			"hold for background",
		]);
		one.move.cancel();
		expect(one.reloads.at(-1)).toBe("let go");
	});

	it("keeps the hold once made until its session stops", () => {
		const one = session();
		one.move.move("background");
		expect(one.did).toEqual(["note background", "close"]);
		one.move.look();
		expect(one.reloads).toEqual(["hold for background"]);
		one.move.stop();
		expect(one.reloads).toEqual(["hold for background", "let go"]);
	});

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
		// Asked half an hour before, inside the bound a move waits for.
		one.moving = { to: "background", since: "2026-11-10T08:30:00.000Z" };
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

	it("calls itself off once what holds it outlasts its bound, saying why, and stays plain", () => {
		const one = session("a fleet is out (j2: k7-read)");
		one.move.move("attended");
		one.time = ASKED + MOVE_WAIT_MOST_MS - 1;
		one.tick?.();
		expect(one.moving?.holds).toBe("a fleet is out (j2: k7-read)");
		one.time = ASKED + MOVE_WAIT_MOST_MS;
		one.tick?.();
		expect(one.moving).toBeUndefined();
		expect(one.tick).toBeUndefined();
		expect(one.offs).toEqual([
			{
				to: "attended",
				since: "2026-11-10T09:00:00.000Z",
				at: "2026-11-10T09:45:00.000Z",
				why: "it waited 45 minutes and is still held: a fleet is out (j2: k7-read)",
			},
		]);
		expect(one.told.at(-1)).toBe(
			"The move to the attended host is off: it waited 45 minutes and is still held: a fleet is out (j2: k7-read).",
		);
		one.holds = undefined;
		one.move.look();
		expect(one.did, "nothing moves once it is off").toEqual([]);
	});

	it("counts its bound from when the move was asked, through a reload", () => {
		const one = session("background jobs are out");
		one.moving = { to: "background", since: "2026-11-10T08:00:00.000Z" };
		one.move.look();
		expect(one.moving).toBeUndefined();
		expect(one.offs[0]?.why).toMatch(/waited 45 minutes/);
		expect(one.did).toEqual([]);
	});

	it("bounds a move in place that finds no quiet moment as well", () => {
		const one = session();
		const keyed = { at: ASKED };
		const waiting = createMoving({
			holds: () => undefined,
			hosted: () => false,
			moving: () => one.moving,
			setMoving: (now) => {
				one.moving = now;
			},
			calledOff: (off) => {
				one.moving = undefined;
				one.offs.push(off);
			},
			note: (to) => one.did.push(`note ${to}`),
			handOver: () => ({
				tell: () => {
					one.did.push("told");
					return undefined;
				},
				untell: () => one.did.push("untold"),
				quiet: () => one.did.push("handed"),
			}),
			keyedAt: () => keyed.at,
			tell: (text) => one.told.push(text),
			close: () => one.did.push("close"),
			now: () => new Date(one.time),
			every: (_ms, look) => {
				one.tick = look;
				return () => {
					one.tick = undefined;
				};
			},
		});
		waiting.move("background", "here");
		one.time = ASKED + MOVE_WAIT_MOST_MS;
		keyed.at = one.time;
		one.tick?.();
		expect(one.did).toEqual([]);
		expect(one.offs[0]?.why).toMatch(/waited 45 minutes and is still held/);
	});

	it("says why a move the person called off went", () => {
		const one = session("a run is under way");
		one.move.move("background");
		one.time = ASKED + 60_000;
		one.move.cancel();
		expect(one.offs).toEqual([
			{
				to: "background",
				since: "2026-11-10T09:00:00.000Z",
				at: "2026-11-10T09:01:00.000Z",
				why: "the person is at the desk",
			},
		]);
	});

	it("ends a run that holds a move back to plain pi past its wait, at its turn's end, then lets it go", () => {
		const one = session("a run is under way", true);
		one.move.move("pi");
		one.time = ASKED + RELEASE_WAIT_MS - 1;
		one.tick?.();
		one.move.turnEnded();
		expect(one.cuts, "a run inside the wait goes on").toEqual([]);
		one.time = ASKED + RELEASE_WAIT_MS;
		one.tick?.();
		expect(one.moving?.holds).toBe(
			"a run is under way, ending at its turn's end after 5 minutes",
		);
		expect(one.cuts, "mid-turn, its tool runs on").toEqual([]);
		one.move.turnEnded();
		expect(one.cuts).toEqual([
			"a move to plain pi that waited 5 minutes on its run",
		]);
		one.holds = undefined;
		one.tick?.();
		expect(one.did).toEqual(["note pi", "close"]);
	});

	it("ends a run that starts while it waits to let go of one it ended", () => {
		const one = session("a run is under way", true);
		one.move.move("pi");
		one.time = ASKED + RELEASE_WAIT_MS;
		one.tick?.();
		one.move.turnEnded();
		one.move.started();
		expect(one.cuts).toHaveLength(2);
	});

	it("ends no run for a move into a host, a hold that isn't a run, or a move called off", () => {
		const into = session("a run is under way", true);
		into.move.move("attended");
		const job = session("a fleet is out (j2: k7-read)", true);
		job.move.move("pi");
		const off = session("a run is under way", true);
		off.move.move("pi");
		for (const one of [into, job, off]) {
			one.time = ASKED + RELEASE_WAIT_MS;
			one.tick?.();
		}
		off.move.cancel();
		for (const one of [into, job, off]) {
			one.move.turnEnded();
			one.move.started();
			expect(one.cuts).toEqual([]);
		}
		expect(job.moving?.holds).toBe("a fleet is out (j2: k7-read)");
	});

	it("ends once, however often it is asked after", () => {
		const one = session();
		one.move.move("background");
		one.move.move("attended");
		one.move.look();
		expect(one.did).toEqual(["note background", "close"]);
	});
});

describe("what holds a move", () => {
	const moved = "01a1ecbb-0000-7000-8000-0000000a07ed";

	/** An idle session whose job host has `pending` jobs, `held` of them holding. */
	function holding(
		pending: number,
		held?: readonly JobHold[],
		options: Parameters<typeof holdsOf>[3] = {},
	) {
		const events = createEventBus();
		announceJobHost(events, {
			start: () => {
				throw new Error("nothing starts here");
			},
			pending: () => pending,
			...(held ? { holds: () => held } : {}),
		});
		const ctx = {
			hasUI: false,
			isIdle: () => true,
			hasPendingMessages: () => false,
			sessionManager: { getSessionId: () => moved },
		};
		return holdsOf(ctx as unknown as ExtensionContext, events, 0, options);
	}

	// A carry ends the session's run, so it reads as free while its work
	// is bundled; a move then would end it before its done file is written.
	it("holds while a carry of its work is under way", () => {
		const carry = holdForCarry(moved, "penelope");
		try {
			expect(holding(0, [])).toBe("its work is being carried to penelope");
		} finally {
			carry.release();
		}
		expect(holding(0, [])).toBeUndefined();
	});

	it("sets aside the carry asking, but not another", () => {
		const own = holdForCarry(moved, "penelope");
		try {
			const alone = holding(0, [], { ownCarry: own });
			const person = holdForCarry(moved, "equilibrius");
			try {
				expect(alone).toBeUndefined();
				expect(holding(0, [], { ownCarry: own })).toBe(
					"its work is being carried to equilibrius",
				);
			} finally {
				person.release();
			}
		} finally {
			own.release();
		}
	});

	it("names only the jobs that can't be carried, by kind and id", () => {
		expect(holding(2, [{ id: "j2", kind: "subagent", label: "k7-read" }])).toBe(
			"a fleet is out (j2: k7-read)",
		);
	});

	it("is nothing when every running job can be carried", () => {
		expect(holding(1, [])).toBeUndefined();
	});

	it("counts every job out when the host can't say which hold", () => {
		expect(holding(1)).toBe("background jobs are out");
	});
});

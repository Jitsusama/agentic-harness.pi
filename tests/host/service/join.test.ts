/**
 * The join: the window becomes the host's viewer once the host has the
 * conversation open, or plain pi again once nobody takes the move up,
 * and plain pi again after a release once no host holds it.
 */
import { describe, expect, it } from "vitest";
import {
	JOIN_GRACE_MS,
	JOIN_LOOK_MS,
	type JoinFacts,
	joinMove,
	joinRelease,
} from "../../../host/service/join.ts";
import type { HostHold } from "../../../lib/internal/session/host-holds.ts";
import type {
	NoteState,
	TakeBack,
} from "../../../lib/internal/session/move.ts";

const OPEN: HostHold = { key: "work-attended", realm: "work", open: true };
const KEPT: HostHold = { key: "work-attended", realm: "work", open: false };

interface Look {
	readonly hold?: HostHold;
	readonly noted: NoteState;
}

/** A join whose world is, look by look, what `looks` says. */
function joined(
	looks: readonly Look[],
	takeBack: () => TakeBack = () => "taken",
): {
	facts: JoinFacts;
	restored: () => number;
	tookBack: () => number;
	said: string[];
} {
	let clock = 0;
	let look = 0;
	let restored = 0;
	let tookBack = 0;
	const said: string[] = [];
	const now = () => looks[Math.min(look, looks.length - 1)];
	return {
		facts: {
			hold: async () => now()?.hold,
			noted: () => now()?.noted ?? "none",
			restoreStranded: () => {
				restored += 1;
			},
			takeBack: () => {
				tookBack += 1;
				return takeBack();
			},
			say: (line) => said.push(line),
			now: () => clock,
			pause: async (ms) => {
				clock += ms;
				look += 1;
			},
		},
		restored: () => restored,
		tookBack: () => tookBack,
		said,
	};
}

/** Looks for `ms` of one state. */
function lasting(ms: number, state: Look): Look[] {
	return Array.from({ length: ms / JOIN_LOOK_MS }, () => state);
}

describe("the join", () => {
	it("becomes the host's viewer once the host has it open", async () => {
		const join = joined([
			...lasting(2_000, { noted: "waiting" }),
			{ hold: KEPT, noted: "none" },
			{ hold: OPEN, noted: "none" },
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
		expect(join.tookBack()).toBe(0);
		expect(join.restored(), "stranded claims given back each look").toBe(10);
		expect(join.said).toEqual([]);
	});

	it("takes the move back once its note waits unclaimed past the grace", async () => {
		const join = joined(lasting(JOIN_GRACE_MS * 2, { noted: "waiting" }));
		expect(await joinMove(join.facts)).toEqual({ to: "pi" });
		expect(join.tookBack()).toBe(1);
	});

	it("waits on a note a cutover holds, however long it takes", async () => {
		const join = joined([
			...lasting(JOIN_GRACE_MS * 3, { noted: "claimed" }),
			{ hold: OPEN, noted: "none" },
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
		expect(join.tookBack()).toBe(0);
	});

	it("runs plain pi once nothing at all has held it past the grace", async () => {
		const join = joined([
			...lasting(JOIN_GRACE_MS - JOIN_LOOK_MS, { noted: "claimed" }),
			...lasting(JOIN_GRACE_MS * 2, { noted: "none" }),
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "pi" });
		expect(join.tookBack(), "no note left to take back").toBe(0);
	});

	it("doesn't run plain pi while nothing holds it for less than the grace", async () => {
		const join = joined([
			...lasting(JOIN_GRACE_MS - JOIN_LOOK_MS, { noted: "none" }),
			{ hold: OPEN, noted: "none" },
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
	});

	it("waits on a host that kept it on its roster, and says so once", async () => {
		const join = joined([
			...lasting(JOIN_GRACE_MS * 3, { hold: KEPT, noted: "waiting" }),
			{ hold: OPEN, noted: "none" },
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
		expect(join.tookBack()).toBe(0);
		expect(join.said).toEqual([
			"Waiting for the work-attended host to start; this window carries on there.",
		]);
	});

	it("counts the grace afresh once a cutover has claimed the note", async () => {
		const join = joined([
			...lasting(JOIN_GRACE_MS - JOIN_LOOK_MS, { noted: "waiting" }),
			{ noted: "claimed" },
			...lasting(JOIN_GRACE_MS - JOIN_LOOK_MS, { noted: "waiting" }),
			{ hold: OPEN, noted: "none" },
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
		expect(join.tookBack()).toBe(0);
	});

	it("keeps waiting when a cutover's adopt beats its take-back", async () => {
		let tries = 0;
		const join = joined(
			[
				...lasting(JOIN_GRACE_MS + JOIN_LOOK_MS, { noted: "waiting" }),
				{ hold: OPEN, noted: "none" },
			],
			() => {
				tries += 1;
				return "adopting";
			},
		);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
		expect(tries).toBeGreaterThan(0);
	});
});

describe("the join after a release", () => {
	it("runs plain pi once no host holds the conversation at all", async () => {
		const join = joined([
			...lasting(1_000, { hold: OPEN, noted: "none" }),
			...lasting(1_000, { hold: KEPT, noted: "none" }),
			{ noted: "none" },
		]);
		expect(await joinRelease(join.facts)).toEqual({ to: "pi" });
		expect(join.facts.now(), "it waited out the host").toBe(2_000);
		expect(join.said).toEqual([]);
	});

	it("waits on a host still holding it past the grace, saying so once", async () => {
		const join = joined([
			...lasting(JOIN_GRACE_MS * 3, { hold: KEPT, noted: "none" }),
			{ noted: "none" },
		]);
		expect(await joinRelease(join.facts)).toEqual({ to: "pi" });
		expect(join.said).toEqual([
			"Waiting for the work-attended host to let the conversation go; plain pi carries on here once it has.",
		]);
	});
});

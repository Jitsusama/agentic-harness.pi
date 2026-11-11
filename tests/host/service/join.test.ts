/**
 * The join: the window becomes the host's viewer once the host has the
 * conversation open, or plain pi again once nobody takes the move up.
 */
import { describe, expect, it } from "vitest";
import {
	JOIN_GRACE_MS,
	JOIN_LOOK_MS,
	type JoinFacts,
	joinMove,
} from "../../../host/service/join.ts";
import type { HostHold } from "../../../lib/internal/session/host-holds.ts";
import type { TakeBack } from "../../../lib/internal/session/move.ts";

const OPEN: HostHold = { key: "work-attended", realm: "work", open: true };
const KEPT: HostHold = { key: "work-attended", realm: "work", open: false };

/** A join whose world is, look by look, what `looks` says. */
function joined(
	looks: readonly { hold?: HostHold; noted: boolean }[],
	takeBack: () => TakeBack = () => "taken",
): { facts: JoinFacts; restored: () => number; tookBack: () => number } {
	let clock = 0;
	let look = 0;
	let restored = 0;
	let tookBack = 0;
	const now = () => looks[Math.min(look, looks.length - 1)];
	return {
		facts: {
			hold: async () => now()?.hold,
			noted: () => now()?.noted ?? false,
			restoreStranded: () => {
				restored += 1;
			},
			takeBack: () => {
				tookBack += 1;
				return takeBack();
			},
			now: () => clock,
			pause: async (ms) => {
				clock += ms;
				look += 1;
			},
		},
		restored: () => restored,
		tookBack: () => tookBack,
	};
}

/** Looks for `ms` of one state. */
function lasting(ms: number, state: { hold?: HostHold; noted: boolean }) {
	return Array.from({ length: ms / JOIN_LOOK_MS }, () => state);
}

describe("the join", () => {
	it("becomes the host's viewer once the host has it open", async () => {
		const join = joined([
			...lasting(2_000, { noted: true }),
			{ hold: KEPT, noted: false },
			{ hold: OPEN, noted: false },
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
		expect(join.tookBack()).toBe(0);
		expect(join.restored(), "stranded claims given back each look").toBe(10);
	});

	it("takes the move back once its note waits unclaimed past the grace", async () => {
		const join = joined(lasting(JOIN_GRACE_MS * 2, { noted: true }));
		expect(await joinMove(join.facts)).toEqual({ to: "pi" });
		expect(join.tookBack()).toBe(1);
	});

	it("waits on a note a cutover holds, however long it takes", async () => {
		const join = joined([
			...lasting(JOIN_GRACE_MS * 3, { noted: false }),
			{ hold: OPEN, noted: false },
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
		expect(join.tookBack()).toBe(0);
	});

	it("waits on a host that kept it on its roster", async () => {
		const join = joined([
			...lasting(JOIN_GRACE_MS * 3, { hold: KEPT, noted: true }),
			{ hold: OPEN, noted: false },
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
		expect(join.tookBack()).toBe(0);
	});

	it("counts the grace afresh once a cutover has claimed the note", async () => {
		const join = joined([
			...lasting(JOIN_GRACE_MS - JOIN_LOOK_MS, { noted: true }),
			{ noted: false },
			...lasting(JOIN_GRACE_MS - JOIN_LOOK_MS, { noted: true }),
			{ hold: OPEN, noted: false },
		]);
		expect(await joinMove(join.facts)).toEqual({ to: "host", hold: OPEN });
		expect(join.tookBack()).toBe(0);
	});

	it("keeps waiting when a cutover's adopt beats its take-back", async () => {
		let tries = 0;
		const join = joined(
			[
				...lasting(JOIN_GRACE_MS + JOIN_LOOK_MS, { noted: true }),
				{ hold: OPEN, noted: false },
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

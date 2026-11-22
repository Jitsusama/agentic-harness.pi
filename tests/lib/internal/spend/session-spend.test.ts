/**
 * A session's spend read from its branch: every turn, or what a rollover
 * record carried and the turns after it.
 */

import { describe, expect, it } from "vitest";
import { ROLLOVER_RECORD } from "../../../../lib/internal/session/rollover.ts";
import {
	SPEND_CARRY,
	spentOnBranch,
} from "../../../../lib/internal/spend/session-spend.ts";

/** An assistant turn costing `total`. */
function turn(id: string, total: number) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-22T00:00:00.000Z",
		message: { role: "assistant", usage: { cost: { total } } },
	};
}

/** A rollover record carrying `spend`. */
function record(spend: number) {
	return {
		type: "custom",
		id: "r",
		parentId: null,
		timestamp: "2026-11-22T00:00:00.000Z",
		customType: ROLLOVER_RECORD,
		data: {
			parentSession: "/log",
			parentLeaf: "x",
			dropped: 0,
			carried: { [SPEND_CARRY]: { spend } },
		},
	};
}

describe("a session's spend", () => {
	it("adds every turn on a branch with no record", () => {
		expect(spentOnBranch([turn("a", 1), turn("b", 2.5)])).toBeCloseTo(3.5);
	});

	it("counts no turn below zero", () => {
		expect(spentOnBranch([turn("a", 1), turn("b", -4)])).toBeCloseTo(1);
	});

	it("adds what a record carried to the turns after it", () => {
		expect(
			spentOnBranch([turn("a", 9), record(3), turn("b", 0.5)]),
		).toBeCloseTo(3.5);
	});

	it("reads nothing from entries that are not messages", () => {
		expect(
			spentOnBranch([{ type: "custom", id: "c", data: {} }, turn("a", 1)]),
		).toBeCloseTo(1);
	});
});

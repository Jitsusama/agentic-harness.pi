import { describe, expect, it } from "vitest";
import {
	cellSteer,
	steerCell,
	steeredFrom,
} from "../../../lib/mesh/cell-steer.ts";

/** A node that answers `line`, keeping what it was asked. */
function node(line: string | undefined) {
	const asked: unknown[] = [];
	return {
		asked,
		ask: async (_socket: string | undefined, request: unknown) => {
			asked.push(request);
			return line;
		},
	};
}

const STEERED = JSON.stringify({
	Ok: { Steered: { machine: "tern", by: null } },
});

describe("holding or waking another cell", () => {
	it("signs the steer with the session sending it, never as the person", () => {
		expect(
			cellSteer("hold", "85PKB2", new Date("2026-11-24T14:30:00Z")),
		).toEqual({
			act: "pause",
			from: "85PKB2",
			at: "2026-11-24T14:30:00.000Z",
		});
		expect(cellSteer("wake", "85PKB2").act).toBe("resume");
	});

	it("asks the node to steer the cell, and says the machine it told", async () => {
		const { ask, asked } = node(STEERED);

		const steered = await steerCell(
			"/run/node.sock",
			"A1B2C3",
			"hold",
			"85PKB2",
			ask,
		);

		expect(steered).toEqual({ ok: true, machine: "tern" });
		expect(asked).toEqual([
			{
				Steer: {
					address: "A1B2C3",
					steer: expect.objectContaining({ act: "pause", from: "85PKB2" }),
				},
			},
		]);
	});

	it("says the node's own reason when it refuses", async () => {
		const { ask } = node(
			JSON.stringify({ Err: "no session goes by A1B2C3 now" }),
		);

		expect(await steerCell("/s", "A1B2C3", "wake", "85PKB2", ask)).toEqual({
			ok: false,
			reason: "no session goes by A1B2C3 now",
		});
	});

	it("says a silent node may or may not have told it, and no node at all", async () => {
		const silent = await steerCell(
			"/s",
			"A1B2C3",
			"hold",
			"85PKB2",
			node(undefined).ask,
		);
		const none = await steerCell(
			undefined,
			"A1B2C3",
			"hold",
			"85PKB2",
			node(undefined).ask,
		);

		expect(silent).toMatchObject({ ok: false });
		expect(silent.ok ? "" : silent.reason).toContain("may or may not");
		expect(none.ok ? "" : none.reason).toContain("no mycelium node");
	});

	it("refuses what is no address, and itself, asking the node nothing", async () => {
		const { ask, asked } = node(STEERED);

		const odd = await steerCell("/s", "../x", "hold", "85PKB2", ask);
		const itself = await steerCell("/s", "85pkb2", "hold", "85PKB2", ask);

		expect(odd.ok).toBe(false);
		expect(itself.ok ? "" : itself.reason).toContain("is this session");
		expect(asked).toEqual([]);
	});

	it("reads an answer it doesn't know as not told", () => {
		expect(steeredFrom("not json").ok).toBe(false);
		expect(steeredFrom(JSON.stringify({ Ok: { Started: {} } })).ok).toBe(false);
	});
});

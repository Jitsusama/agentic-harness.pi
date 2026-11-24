import { describe, expect, it } from "vitest";
import {
	cellSteer,
	steerCell,
	steeredFrom,
} from "../../../lib/mesh/cell-steer.ts";
import type { Heard } from "../../../lib/mesh/node.ts";

/** A node that is heard as `heard`, keeping what it was asked. */
function node(heard: Heard) {
	const asked: unknown[] = [];
	return {
		asked,
		hear: async (_socket: string | undefined, request: unknown) => {
			asked.push(request);
			return heard;
		},
	};
}

/** A node answering `line`. */
function answering(line: string) {
	return node({ kind: "answered", line });
}

const STEERED = JSON.stringify({
	Ok: { Steered: { machine: "tern", by: null } },
});

/** A session signing as 85PKB2 that goes by that alone. */
const SIGNER = { from: "85PKB2", own: ["85PKB2"] };

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
		const { hear, asked } = answering(STEERED);

		const steered = await steerCell(
			"/run/node.sock",
			"A1B2C3",
			"hold",
			SIGNER,
			hear,
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
		const { hear } = answering(
			JSON.stringify({ Err: "no session goes by A1B2C3 now" }),
		);

		expect(await steerCell("/s", "A1B2C3", "wake", SIGNER, hear)).toEqual({
			ok: false,
			reason: "no session goes by A1B2C3 now",
		});
	});

	it("tells a node that took the steer and said nothing from one that hung up", async () => {
		const silent = await steerCell(
			"/s",
			"A1B2C3",
			"hold",
			SIGNER,
			node({ kind: "silent", hungUp: false }).hear,
		);
		const hungUp = await steerCell(
			"/s",
			"A1B2C3",
			"hold",
			SIGNER,
			node({ kind: "silent", hungUp: true }).hear,
		);

		expect(silent.ok ? "" : silent.reason).toContain("answered nothing");
		expect(silent.ok ? "" : silent.reason).toContain("may or may not");
		expect(hungUp.ok ? "" : hungUp.reason).toContain("hung up");
	});

	it("says nothing was sent when no node is there, naming where it looked", async () => {
		const unreached = node({ kind: "unreached" }).hear;

		const at = await steerCell(
			"/run/n.sock",
			"A1B2C3",
			"hold",
			SIGNER,
			unreached,
		);
		const none = await steerCell(
			undefined,
			"A1B2C3",
			"hold",
			SIGNER,
			unreached,
		);

		expect(at.ok ? "" : at.reason).toBe(
			"no mycelium node answered at /run/n.sock, so nothing was sent",
		);
		expect(none.ok ? "" : none.reason).toContain("no mycelium node runs here");
	});

	it("refuses what is no address, and any address it goes by, asking the node nothing", async () => {
		const { hear, asked } = answering(STEERED);
		const signer = { from: "85PKB2", own: ["QUESTX", "25243C75"] };

		const odd = await steerCell("/s", "../x", "hold", signer, hear);
		const signed = await steerCell("/s", "85pkb2", "hold", signer, hear);
		const ownCell = await steerCell("/s", "25243c75", "wake", signer, hear);

		expect(odd.ok).toBe(false);
		expect(signed.ok ? "" : signed.reason).toContain("is this session");
		expect(ownCell.ok ? "" : ownCell.reason).toContain("is this session");
		expect(asked).toEqual([]);
	});

	it("reads an answer it doesn't know as not told", () => {
		expect(steeredFrom("not json").ok).toBe(false);
		expect(steeredFrom(JSON.stringify({ Ok: { Started: {} } })).ok).toBe(false);
	});
});

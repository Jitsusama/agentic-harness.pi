import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createLeasing,
	leasesText,
} from "../../../extensions/mesh-workflow/leases.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import {
	createBoard,
	MOST_HOLD_MS,
	type OwnLeases,
	ownLeases,
} from "../../../lib/mesh/lease.ts";
import type { Draft } from "../../../lib/mesh/message.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import { createPresences, type Presence } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-leasing-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Leasing for a peer signing as LUQ49E, with its own leases. */
function leasing() {
	const board = createBoard(join(root, "leases"));
	const transport = folderTransport(join(root, "messages"));
	const own: OwnLeases = ownLeases(board, "me");
	const self = {
		session: "me",
		addresses: ["LUQ49E"],
		signature: "LUQ49E",
	} as unknown as Peer;
	const at = createLeasing({
		board,
		presences: createPresences(join(root, "presence")),
		transport,
		own: () => own,
		peer: () => self,
		sent: () => {},
	});
	const from = (over: Partial<Draft>) =>
		transport.send({
			from: "WCJQSG",
			to: [ALL],
			intent: "fyi",
			text: "x",
			pid: process.pid + 1,
			...over,
		});
	const mine = (over: Partial<Draft>) =>
		from({ from: "LUQ49E", pid: process.pid, ...over });
	return { at, own, from, mine };
}

describe("a wait on a hold", () => {
	it("ends by the clock once the hold has stood two hours", async () => {
		const { at, own, from, mine } = leasing();
		const hold = from({ intent: "hold", text: "hold qemu" });
		at.sent(mine({ re: hold.id, text: "my test waits" }));

		expect(await at.lapsed(Date.now() + MOST_HOLD_MS - 60_000)).toEqual([]);
		const ends = await at.lapsed(Date.now() + MOST_HOLD_MS);

		expect(ends).toEqual([
			{
				hold,
				how: "it has stood two hours, as long as a hold lasts",
				why: "my test waits",
			},
		]);
		expect(own.leases).toEqual([]);
	});

	it("moves to the hold that replaces it, and ends with that one", () => {
		const { at, own, from, mine } = leasing();
		const hold = from({ intent: "hold", text: "hold qemu" });
		at.sent(mine({ re: hold.id, text: "waiting" }));

		const longer = from({
			intent: "hold",
			supersedes: hold.id,
			text: "hold qemu and nix",
		});
		expect(at.ended(longer)).toBeUndefined();
		expect(own.leases).toMatchObject([{ kind: "wait", subject: longer.id }]);

		const over = from({ supersedes: longer.id, text: "done" });
		expect(at.ended(over)).toMatchObject({ hold: longer, why: "waiting" });
		expect(own.leases).toEqual([]);
	});

	it("is not ended by a peer other than the holder", () => {
		const { at, own, from, mine } = leasing();
		const hold = from({ intent: "hold", text: "hold qemu" });
		at.sent(mine({ re: hold.id, text: "waiting" }));

		const other = from({
			from: "P9R1KI",
			pid: process.pid + 2,
			re: hold.id,
			text: "over, I think",
		});

		expect(at.ended(other)).toBeUndefined();
		expect(own.leases).toMatchObject([{ kind: "wait", subject: hold.id }]);
	});

	it("is not taken on this peer's own hold, nor on what is not a hold", () => {
		const { at, own, from, mine } = leasing();
		const question = from({ intent: "question", text: "who has qemu?" });
		at.sent(mine({ re: question.id, text: "me" }));
		const hold = mine({ intent: "hold", text: "hold builds" });
		at.sent(hold);
		at.sent(mine({ re: hold.id, text: "still holding" }));

		expect(own.leases.map(({ kind }) => kind)).toEqual([]);
	});
});

describe("leases as listed", () => {
	const present = (session: string, address: string): Presence => ({
		session,
		addresses: [address],
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		at: "",
	});

	it("count a peer's changes past the first three, and say the rest by kind", () => {
		const now = Date.now();
		const until = new Date(now + 60_000).toISOString();
		const lease = (kind: string, subject: string, why?: string) => ({
			kind,
			subject,
			since: "",
			until,
			...(why ? { why } : {}),
		});
		const board = [
			{
				session: "w",
				leases: [
					lease("change", "a"),
					lease("change", "b"),
					lease("change", "c"),
					lease("change", "d"),
					lease("change", "e"),
					lease("wait", "20261022-0101-0001-aaaaaaaa", "my test"),
					lease("heavy", "qemu", "vm test"),
					{ ...lease("answer", "x"), until: new Date(now - 1).toISOString() },
				],
			},
			{ session: "gone", leases: [lease("change", "z")] },
		] as never;

		expect(leasesText(board, [present("w", "WCJQSG")], now)).toBe(
			"\nLeases:\nWCJQSG: changing a, b, c and 2 more; waiting on [aaaaaaaa] (my test); running heavy work on qemu (vm test)",
		);
		expect(leasesText([], [present("w", "WCJQSG")], now)).toBe("");
	});
});

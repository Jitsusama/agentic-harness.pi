import { describe, expect, it } from "vitest";
import { ALL, homeOf } from "../../../lib/mesh/group.ts";
import {
	handIn,
	holdsReaching,
	isSubagent,
	MESH_SESSION_ENV,
} from "../../../lib/mesh/hand.ts";
import type { Holding, Lease } from "../../../lib/mesh/lease.ts";
import type { Message } from "../../../lib/mesh/message.ts";

const at = Date.parse("2026-10-22T13:00:00Z");
const minutes = (count: number) => count * 60 * 1000;

describe("a subagent", () => {
	it("is told by the environment its supervisor starts it with", () => {
		expect(isSubagent({ SUBAGENT_SUPERVISOR: "1" })).toBe(true);
		expect(isSubagent({ SUBAGENT_RUN_ID: "run" })).toBe(true);
		expect(isSubagent({})).toBe(false);
	});
});

describe("a hand", () => {
	const fleet = { SUBAGENT_RUN_ID: "run-1", SUBAGENT_ID: "lens" };

	it("is a subagent working for the peer its environment names", () => {
		expect(handIn({ ...fleet, [MESH_SESSION_ENV]: "parent" }, 42)).toEqual({
			of: "parent",
			session: "parent.hand.run-1.lens",
		});
	});

	it("is known by its process when the fleet does not name it", () => {
		expect(
			handIn({ SUBAGENT_SUPERVISOR: "1", [MESH_SESSION_ENV]: "parent" }, 42),
		).toEqual({ of: "parent", session: "parent.hand.42" });
	});

	it("is nothing outside a fleet, or for a fleet no peer started", () => {
		expect(handIn({ [MESH_SESSION_ENV]: "parent" }, 42)).toBeUndefined();
		expect(handIn(fleet, 42)).toBeUndefined();
		expect(handIn({ ...fleet, [MESH_SESSION_ENV]: " " }, 42)).toBeUndefined();
	});
});

describe("the holds reaching a peer", () => {
	const message = (over: Partial<Message>): Message => ({
		v: 1,
		id: "20261022T130000000Z-aaaa",
		at: new Date(at).toISOString(),
		from: "P9R1KI",
		to: [ALL],
		intent: "hold",
		text: "hold builds",
		pid: 1,
		...over,
	});
	const hold = (subject: string, until = at + minutes(10)): Lease => ({
		kind: "hold",
		subject,
		since: new Date(at).toISOString(),
		until: new Date(until).toISOString(),
	});
	const sent = [
		message({ id: "b-2" }),
		message({ id: "a-1" }),
		message({ id: "lapsed" }),
		message({ id: "elsewhere", to: ["#elsewhere"] }),
		message({ id: "an-fyi", intent: "fyi" }),
		message({ id: "its-own", from: "LUQ49E" }),
	];
	const board: Holding[] = [
		{
			session: "holder",
			leases: [
				hold("b-2"),
				hold("a-1"),
				hold("lapsed", at - 1),
				hold("elsewhere"),
				hold("an-fyi"),
				hold("its-own"),
				hold("gone"),
				{ ...hold("a-1"), kind: "wait" },
			],
		},
	];
	const read = (id: string) => sent.find((one) => one.id === id);

	it("are the current holds sent where it hears, oldest first", () => {
		const listener = { addresses: ["LUQ49E"], groups: [] };

		expect(
			holdsReaching(board, read, listener, 7, at).map(({ hold }) => hold.id),
		).toEqual(["a-1", "b-2"]);
	});

	it("leave out a hold taken before the machine booted", () => {
		// A holder the reboot ended and nobody restored keeps its lease on
		// the board, which held back every hand's heavy work for two hours.
		const listener = { addresses: ["LUQ49E"], groups: [] };

		expect(holdsReaching(board, read, listener, 7, at, at + 1)).toEqual([]);
		expect(
			holdsReaching(board, read, listener, 7, at, at).map(
				({ hold }) => hold.id,
			),
		).toEqual(["a-1", "b-2"]);
	});

	it("include one sent to its home group", () => {
		const home = [
			{ session: "holder", leases: [hold("home")] },
		] satisfies Holding[];
		const to = message({ id: "home", to: [homeOf("LUQ49E")] });

		expect(
			holdsReaching(
				home,
				() => to,
				{ addresses: ["LUQ49E"], groups: [] },
				7,
				at,
			).map(({ lease }) => lease.subject),
		).toEqual(["home"]);
	});
});

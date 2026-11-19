/**
 * Whether an ask to end a machine's sessions is refused: while the node
 * says any session other than the asker's is there in any state but
 * ended, and whenever the node can't be read.
 */

import { describe, expect, it } from "vitest";
import type { SessionEndingAsk } from "../../../../lib/internal/session-ending/asks.ts";
import {
	machinesKnown,
	refusalOf as refusal,
} from "../../../../lib/internal/session-ending/judge.ts";
import type { NodeSession } from "../../../../lib/mesh/node.ts";

const SELF = "self-id";

/** Why the asks are refused, or nothing when they aren't. */
const refusalOf = (...args: Parameters<typeof refusal>) =>
	refusal(...args)?.reason;

const ask = (
	act: SessionEndingAsk["act"],
	...machines: string[]
): SessionEndingAsk => ({
	act,
	machines,
	said: `${act} ${machines.join(" ")}`,
});

const on = (
	machine: string,
	state: NodeSession["state"],
	address: string,
	id = address.toLowerCase(),
): NodeSession => ({ id, address, machine, state });

describe("an ask on a named machine", () => {
	it("is refused while another session is busy there, naming it", () => {
		const reason = refusalOf(
			[ask("log out", "equilibrius")],
			[on("equilibrius", "busy", "EWUL44")],
			SELF,
		);

		expect(reason).toContain("log out on equilibrius");
		expect(reason).toContain("EWUL44 (busy)");
	});

	it("is refused for an idle session too, and one whose link dropped", () => {
		expect(
			refusalOf(
				[ask("reboot", "optimus")],
				[on("optimus", "idle", "LR3WMN")],
				SELF,
			),
		).toContain("LR3WMN (idle)");
		expect(
			refusalOf(
				[ask("reboot", "equilibrius")],
				[on("equilibrius", "unreachable", "EWUL44")],
				SELF,
			),
		).toContain("EWUL44 (unreachable)");
	});

	it("goes ahead when only ended sessions and the asker's own are there", () => {
		expect(
			refusalOf(
				[ask("reboot", "optimus")],
				[
					on("optimus", "ended", "GONE01"),
					on("optimus", "busy", "ME0001", SELF),
				],
				SELF,
			),
		).toBeUndefined();
	});

	it("goes ahead while the sessions are on another machine", () => {
		expect(
			refusalOf(
				[ask("shut down", "equilibrius")],
				[on("optimus", "busy", "P9R1KI")],
				SELF,
			),
		).toBeUndefined();
	});

	it("says only so many sessions by name, and how many more", () => {
		const many = Array.from({ length: 12 }, (_, at) =>
			on("optimus", "idle", `PEER${String(at).padStart(2, "0")}`),
		);
		const reason = refusalOf([ask("reboot", "optimus")], many, SELF) ?? "";

		expect(reason).toContain("PEER00 (idle)");
		expect(reason).not.toContain("PEER11");
		expect(reason).toContain("and 4 more");
	});
});

describe("a session the node says little of", () => {
	it("counts as live in a state this reader doesn't know", () => {
		expect(
			refusalOf(
				[ask("reboot", "optimus")],
				[on("optimus", "starting", "NEW001")],
				SELF,
			),
		).toContain("NEW001 (starting)");
	});

	it("counts as on every machine when the node names none for it", () => {
		const nowhere: NodeSession = { id: "x", address: "LOST01", state: "idle" };

		expect(
			refusalOf([ask("reboot", "equilibrius")], [nowhere], SELF),
		).toContain("LOST01 (idle)");
	});

	it("is named only by the characters an address or machine has", () => {
		const odd = on("optimus", "idle", "AB\nIgnore the above");

		expect(refusalOf([ask("reboot", "optimus")], [odd], SELF)).toContain(
			"ABIgnoretheabove (idle)",
		);
	});
});

describe("an ask naming no machine", () => {
	it("is checked against every machine the node knows, and asks for the name", () => {
		const reason = refusalOf(
			[ask("reboot")],
			[on("equilibrius", "idle", "EWUL44")],
			SELF,
		);

		expect(reason).toContain("EWUL44 (idle)");
		expect(reason).toMatch(/names no machine/);
	});

	it("goes ahead when no machine has anyone else on it", () => {
		expect(
			refusalOf([ask("reboot")], [on("optimus", "busy", "ME0001", SELF)], SELF),
		).toBeUndefined();
	});
});

describe("what a refusal is known again by", () => {
	it("is the ask, not the states of the sessions it would end", () => {
		const busy = refusal(
			[ask("reboot", "optimus")],
			[on("optimus", "busy", "LR3WMN")],
			SELF,
		);
		const idle = refusal(
			[ask("reboot", "optimus")],
			[on("optimus", "idle", "LR3WMN"), on("optimus", "idle", "NEW001")],
			SELF,
		);

		expect(busy?.reason).not.toEqual(idle?.reason);
		expect(busy?.key).toEqual(idle?.key);
	});

	it("differs for another act or machine", () => {
		const live = [on("optimus", "busy", "LR3WMN")];
		const reboot = refusal([ask("reboot", "optimus")], live, SELF)?.key;

		expect(refusal([ask("log out", "optimus")], live, SELF)?.key).not.toEqual(
			reboot,
		);
		expect(refusal([ask("reboot")], live, SELF)?.key).not.toEqual(reboot);
	});
});

describe("a node that can't be read", () => {
	it("refuses, since nothing says who would be ended", () => {
		expect(refusalOf([ask("log out", "equilibrius")], undefined, SELF)).toMatch(
			/couldn't be read/,
		);
	});
});

describe("no ask at all", () => {
	it("goes ahead, whatever the node says", () => {
		expect(refusalOf([], undefined, SELF)).toBeUndefined();
	});
});

describe("the machines an ask can name", () => {
	it("are the node's, and this one's when the node can't be read", () => {
		expect(
			machinesKnown(
				[on("optimus", "busy", "A00001"), on("equilibrius", "idle", "B00001")],
				undefined,
				"optimus",
			),
		).toEqual(["optimus", "equilibrius"]);
		expect(machinesKnown(undefined, undefined, "optimus")).toEqual(["optimus"]);
	});

	it("include the realm's machines that no session is on", () => {
		expect(
			machinesKnown(
				[on("optimus", "busy", "A00001")],
				["optimus", "penelope"],
				"optimus",
			),
		).toEqual(["optimus", "penelope"]);
	});
});

/**
 * Parked peers: which messages and steers start a parked peer again.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	askWake,
	isParked,
	writeParked,
} from "../../../lib/internal/session/park.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import { wakeParked, wakeSteered, wakes } from "../../../lib/mesh/parked.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import { inboxOf } from "../../../lib/mesh/steer.ts";

const parked: Presence = {
	session: "s-parked",
	addresses: ["85PKB2", "8859FF67"],
	groups: ["#quest/wcjqsg"],
	worksOn: "The Harness, Part of the Machine",
	owns: ["agentic-harness.pi"],
	busy: false,
	state: "parked",
	at: "2026-11-06T16:00:00.000Z",
};

function message(over: Partial<Message> = {}): Message {
	return {
		v: 1,
		id: "2-80ECO2-1-aaaa",
		at: "2026-11-06T16:05:00.000Z",
		from: "80ECO2",
		to: ["@85PKB2"],
		text: "by when can you land it?",
		intent: "question",
		pid: 7,
		...over,
	};
}

const nothing = () => undefined;

describe("waking a parked peer", () => {
	it("wakes it for a question or hold sent to it", () => {
		expect(
			wakes(message(), parked, nothing),
			"a question sent to it wakes it",
		).toBe(true);
		expect(
			wakes(message({ intent: "hold" }), parked, nothing),
			"a hold sent to it wakes it",
		).toBe(true);
	});

	it("lets an fyi or finding sent to it wait for its next start", () => {
		expect(
			wakes(message({ intent: "fyi" }), parked, nothing),
			"an fyi sent to it does not wake it",
		).toBe(false);
		expect(
			wakes(message({ intent: "finding" }), parked, nothing),
			"a finding sent to it does not wake it",
		).toBe(false);
	});

	it("wakes an orchestrator for what a session it leads finds or lands", () => {
		const sender: Presence = {
			...parked,
			session: "s-led",
			addresses: ["80ECO2"],
			state: "listening",
			orchestratedBy: "85PKB2",
		};
		const finding = message({ intent: "finding" });
		const landed = message({ intent: "fyi", text: "#920 is merged" });

		expect(
			wakes(finding, parked, nothing, sender),
			"a finding from a session it leads wakes it",
		).toBe(true);
		expect(
			wakes(landed, parked, nothing, sender),
			"a landing from a session it leads wakes it",
		).toBe(true);
		expect(
			wakes(finding, parked, nothing, { orchestratedBy: "WCJQSG" }),
			"a finding from a session another peer leads does not wake it",
		).toBe(false);
		const asked: string[] = [];
		wakeParked(
			landed,
			[parked, sender],
			nothing,
			() => true,
			(session) => asked.push(session),
		);
		expect(asked).toEqual(["s-parked"]);
	});

	it("wakes it for an answer to its question, however it was sent", () => {
		const asked = message({
			id: "1-85PKB2-1-bbbb",
			from: "85PKB2",
			to: ["@80ECO2"],
		});
		const read = (id: string) => (id === asked.id ? asked : undefined);
		const answer = message({ intent: "fyi", re: asked.id });
		expect(
			wakes(answer, parked, read),
			"an fyi answering its question wakes it",
		).toBe(true);
	});

	it("wakes it for a pivot that reaches it", () => {
		const pivot = message({
			intent: "pivot",
			from: "WCJQSG",
			to: ["#quest/wcjqsg"],
		});
		expect(wakes(pivot, parked, nothing), "a pivot to its group wakes it").toBe(
			true,
		);
	});

	it("never wakes it for what doesn't reach it", () => {
		expect(
			wakes(message({ to: ["@5FWIUS"] }), parked, nothing),
			"a question to another peer does not wake it",
		).toBe(false);
	});

	it("asks the holder of only the parked peers whose marker stands", () => {
		const asked: [string, string][] = [];
		const listening: Presence = {
			...parked,
			session: "s-listening",
			state: "listening",
		};
		const unmarked: Presence = { ...parked, session: "s-unmarked" };
		const woken = wakeParked(
			message({ to: ["#quest/wcjqsg"], intent: "pivot", from: "WCJQSG" }),
			[parked, listening, unmarked],
			nothing,
			(session) => session === "s-parked",
			(session, id) => asked.push([session, id]),
		);
		expect(woken).toEqual(["s-parked"]);
		expect(asked).toEqual([["s-parked", "2-80ECO2-1-aaaa"]]);
	});
});

/** Writes a steer into an address's inbox as a writer does: renamed in. */
/** A steer from Joel, as the launcher writes it, naming him. */
function steer(root: string, address: string, body: object): void {
	const inbox = inboxOf(root, address);
	mkdirSync(inbox, { recursive: true });
	writeFileSync(
		join(inbox, "1-a.json.tmp"),
		JSON.stringify({ from: "joel", ...body }),
	);
	renameSync(join(inbox, "1-a.json.tmp"), join(inbox, "1-a.json"));
}

describe("waking a parked peer for a steer", () => {
	it("wakes it for a carry, a close, a move or a fill, which it can only do by running", () => {
		for (const act of [
			{ act: "carry", to: "penelope" },
			{ act: "close" },
			{ act: "move", to: "background" },
			{ act: "fill", text: "Ready for this, if it still holds." },
		]) {
			const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
			steer(root, "8859FF67", act);
			const asked: string[] = [];

			const woken = wakeSteered(
				[parked],
				root,
				() => true,
				(session) => asked.push(session),
			);

			expect(woken, act.act).toEqual(["s-parked"]);
			expect(asked, act.act).toEqual(["s-parked"]);
		}
	});

	it("wakes it for a talk, which a running peer would answer at once", () => {
		for (const said of [
			{ text: "put the void's card on top", id: "talk-1" },
			{ act: "resume", text: "carry on, and say where it went" },
		]) {
			const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
			steer(root, "85PKB2", said);
			const asked: string[] = [];

			const woken = wakeSteered(
				[parked],
				root,
				() => true,
				(session) => asked.push(session),
			);

			expect([woken, asked], said.text).toEqual([["s-parked"], ["s-parked"]]);
		}
	});

	it("lets a pause, a stop or a bare resume wait for its next start, as each does nothing parked", () => {
		for (const act of ["pause", "stop", "resume"]) {
			const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
			steer(root, "85PKB2", { act });

			expect(
				wakeSteered(
					[parked],
					root,
					() => true,
					() => {},
				),
				act,
			).toEqual([]);
		}
	});

	it("asks only for peers parked now, whose marker stands", () => {
		const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
		steer(root, "85PKB2", { act: "carry", to: "penelope" });
		const listening: Presence = {
			...parked,
			session: "s-on",
			state: "listening",
		};

		expect(
			wakeSteered(
				[listening],
				root,
				() => true,
				() => {},
			),
		).toEqual([]);
		expect(
			wakeSteered(
				[parked],
				root,
				() => false,
				() => {},
			),
		).toEqual([]);
	});

	it("writes the wake its holder starts it again on", () => {
		const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
		const park = mkdtempSync(join(tmpdir(), "park-"));
		const wake = join(park, "s-parked.wake");
		writeParked(
			{
				session: "s-parked",
				sessionFile: "/sessions/s-parked.jsonl",
				cwd: "/home/aquifer",
				addresses: parked.addresses,
				parkedAt: "2026-11-07T20:00:00.000Z",
				pid: 4242,
				wake,
			},
			park,
		);
		steer(root, "85PKB2", { act: "carry", to: "penelope" });
		const booted = () => undefined;

		wakeSteered(
			[parked],
			root,
			(session) => isParked(session, park, booted),
			(session, why) => askWake(session, why, park, new Date(), booted),
		);

		expect(JSON.parse(readFileSync(wake, "utf8"))).toMatchObject({
			session: "s-parked",
			messageId: "steer-1-a.json",
		});
	});
});

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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	askWake,
	isParked,
	writeParked,
} from "../../../lib/internal/session/park.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import {
	holderSteers,
	steerWakes,
	WAKING_STEERS,
	wakeParked,
	wakeSteered,
	wakes,
	watchWakingSteers,
} from "../../../lib/mesh/parked.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import {
	giveSteer,
	inboxOf,
	STEER_ACTS,
	steerFrom,
} from "../../../lib/mesh/steer.ts";
import { ORDERED_CARRY } from "../../../lib/mesh/steer-who.ts";
import { quietFor, until } from "../../support/until.ts";

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

	it("wakes a parked orchestrator for news answering its pivot, landing or not", () => {
		const sender: Presence = {
			...parked,
			session: "s-led",
			addresses: ["80ECO2"],
			state: "listening",
			orchestratedBy: "85PKB2",
		};
		const pivot = message({
			id: "1-85PKB2-1-pppp",
			from: "85PKB2",
			intent: "pivot",
			pid: 3,
		});
		const taken = message({
			intent: "fyi",
			re: pivot.id,
			text: "pivot taken; #920 is merged",
		});
		const read = (id: string) => (id === pivot.id ? pivot : undefined);

		expect(
			wakes(taken, parked, read, sender),
			"a parked orchestrator wakes for a landing answering its pivot",
		).toBe(true);
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
function steer(root: string, address: string, body: object): void {
	const inbox = inboxOf(root, address);
	mkdirSync(inbox, { recursive: true });
	writeFileSync(join(inbox, "1-a.json.tmp"), JSON.stringify(body));
	renameSync(join(inbox, "1-a.json.tmp"), join(inbox, "1-a.json"));
}

describe("waking a parked peer for a steer", () => {
	it("wakes it for a carry, a close, a move or a fill, which it can only do by running", async () => {
		for (const act of [
			{ act: "carry", to: "penelope" },
			{ act: "close" },
			{ act: "move", to: "background" },
			{ act: "fill", text: "Ready for this, if it still holds." },
			{
				act: "ordered-carry",
				to: "penelope",
				why: "the Mac",
				by: "WCJQSG",
				from: "WCJQSG",
			},
		]) {
			const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
			steer(root, "8859FF67", act);
			const asked: string[] = [];

			const woken = await wakeSteered(
				[parked],
				root,
				() => true,
				(session) => asked.push(session),
			);

			expect(woken, act.act).toEqual(["s-parked"]);
			expect(asked, act.act).toEqual(["s-parked"]);
		}
	});

	// A record read that timed out turns this machine's own node's live
	// carry down as it is looked at; left asleep, the session would
	// strand it, though its take reads the record again.
	it("wakes it for a node's carry its look turned down, which its take reads again", () => {
		const raw = JSON.stringify({
			act: "ordered-carry",
			to: "penelope",
			why: "optimus has stalled",
			by: "node@optimus",
			from: "node@optimus",
		});
		const steer = steerFrom(raw, "1-a.json", "optimus");
		if (steer?.ordered === undefined) throw new Error(`no carry: ${raw}`);

		expect(steerWakes(steer), "its own node's carry").toBe(true);
		expect(
			steerWakes({
				...steer,
				ordered: { ...steer.ordered, refused: "it names node@kestrel" },
			}),
			"turned down as it was looked at",
		).toBe(true);
	});

	it("wakes it for a talk, which a running peer would answer at once", async () => {
		for (const said of [
			{ text: "put the void's card on top", id: "talk-1" },
			{ act: "resume", text: "carry on, and say where it went" },
		]) {
			const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
			steer(root, "85PKB2", said);
			const asked: string[] = [];

			const woken = await wakeSteered(
				[parked],
				root,
				() => true,
				(session) => asked.push(session),
			);

			expect([woken, asked], said.text).toEqual([["s-parked"], ["s-parked"]]);
		}
	});

	// 14 November: Joel's pick on a look, or his answer to a question,
	// waited for an unrelated wake, as only a running pi takes it.
	it("wakes it for the person's answer to a look or a question, which only a running peer takes", async () => {
		for (const answer of [
			{ act: "answer", look: "look-1", value: "Keep it" },
			{
				act: "answer",
				want: "question@2026-11-14T18:00:00Z",
				other: "neither",
			},
		]) {
			const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
			steer(root, "85PKB2", answer);
			const asked: string[] = [];

			const woken = await wakeSteered(
				[parked],
				root,
				() => true,
				(session) => asked.push(session),
			);

			expect([woken, asked], JSON.stringify(answer)).toEqual([
				["s-parked"],
				["s-parked"],
			]);
		}
	});

	it("lets a pause, a stop or a bare resume wait for its next start, as each does nothing parked", async () => {
		for (const act of ["pause", "stop", "resume"]) {
			const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
			steer(root, "85PKB2", { act });

			expect(
				await wakeSteered(
					[parked],
					root,
					() => true,
					() => {},
				),
				act,
			).toEqual([]);
		}
	});

	it("asks only for peers parked now, whose marker stands", async () => {
		const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
		steer(root, "85PKB2", { act: "carry", to: "penelope" });
		const listening: Presence = {
			...parked,
			session: "s-on",
			state: "listening",
		};

		expect(
			await wakeSteered(
				[listening],
				root,
				() => true,
				() => {},
			),
		).toEqual([]);
		expect(
			await wakeSteered(
				[parked],
				root,
				() => false,
				() => {},
			),
		).toEqual([]);
	});

	// The clock asks this of every parked peer each minute, in every
	// conversation a host holds, so a stalled disk would hold them all.
	it("reads the parked peers' inboxes letting the thread turn", async () => {
		const root = mkdtempSync(join(tmpdir(), "steer-wake-"));
		steer(root, "85PKB2", { act: "close" });
		let turned = false;
		setImmediate(() => {
			turned = true;
		});

		const woken = await wakeSteered(
			[parked],
			root,
			() => true,
			() => {},
		);

		expect(woken).toEqual(["s-parked"]);
		expect(turned, "the thread turned while the inbox was read").toBe(true);
	});

	it("writes the wake its holder starts it again on", async () => {
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

		await wakeSteered(
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

/** How long a steer that lands may take to be said. */
const SAID_WITHIN_MS = 100;

describe("watching a parked peer's steer inboxes", () => {
	let root: string;
	beforeEach(async () => {
		root = join(await mkdtemp(join(tmpdir(), "steer-watch-")), "steer");
	});
	afterEach(async () => {
		await rm(join(root, ".."), { recursive: true, force: true });
	});

	it("says a talk to any of its addresses, once each, and nothing after it closes", async () => {
		const waking = vi.fn();
		const watch = watchWakingSteers({
			root,
			addresses: ["a1b2c3", "QUEST1"],
			waking,
			report: vi.fn(),
		});

		const first = giveSteer(root, "A1B2C3", { text: "one", from: "joel" });
		await until(
			"the first talk to be said",
			() => waking.mock.calls.length > 0,
		);
		const second = giveSteer(root, "QUEST1", { text: "two", from: "joel" });
		await until(
			"the second talk to be said",
			() => waking.mock.calls.length > 1,
		);
		watch.close();
		giveSteer(root, "A1B2C3", { text: "three", from: "joel" });
		await quietFor(SAID_WITHIN_MS, 3);

		expect(waking.mock.calls, "each talk once, in order").toEqual([
			[first],
			[second],
		]);
	});

	it("says one of several already waiting, and none that waits on nothing", async () => {
		const pause = giveSteer(root, "A1B2C3", {
			text: "",
			act: "pause",
			from: "joel",
		});
		const carry = giveSteer(root, "A1B2C3", {
			text: "",
			act: "carry",
			to: "penelope",
			from: "joel",
		});
		const talk = giveSteer(root, "A1B2C3", { text: "and this", from: "joel" });
		const waking = vi.fn();

		const watch = watchWakingSteers({
			root,
			addresses: ["A1B2C3"],
			waking,
			report: vi.fn(),
		});
		await quietFor(SAID_WITHIN_MS, 3);
		watch.close();

		// Written in one millisecond, their names may sort either way.
		expect(waking, "said once for all three").toHaveBeenCalledTimes(1);
		const [said] = waking.mock.calls[0] ?? [];
		expect([carry, talk], "one that waits on it running").toContain(said);
		expect(said, "never the pause").not.toBe(pause);
	});
});

/**
 * A steer as a holder that reads only the declared rule and the raw file
 * judges it, as mycelium's holder does: an act the rule names wakes, a
 * resume with words wakes, and words with no act wake.
 */
function wakesByRule(raw: string): boolean {
	const steer: unknown = JSON.parse(raw);
	if (typeof steer !== "object" || steer === null) return false;
	const act = "act" in steer ? steer.act : undefined;
	const text =
		"text" in steer && typeof steer.text === "string" ? steer.text.trim() : "";
	if (typeof act !== "string") return WAKING_STEERS.talk && text !== "";
	if (act === "resume" && text !== "") return WAKING_STEERS.resumeWithWords;
	return WAKING_STEERS.acts.includes(act);
}

describe("telling a holder in another language which steers wake", () => {
	it("says the rule as data that judges each steer as the mesh does", () => {
		for (const body of [
			{ text: "put the void's card on top" },
			{ act: "resume", text: "carry on" },
			{ act: "resume" },
			{ act: "pause" },
			{ act: "stop" },
			{ act: "close" },
			{ act: "carry", to: "penelope" },
			{ act: "move", to: "background" },
			{ act: "fill", text: "Ready for this." },
			{ act: "answer", look: "look-1", value: "Keep it" },
			{
				act: "ordered-carry",
				to: "penelope",
				why: "the Mac",
				by: "WCJQSG",
				from: "WCJQSG",
			},
		]) {
			const raw = JSON.stringify(body);
			const steer = steerFrom(raw, "1-a.json");
			if (steer === undefined) throw new Error(`not a steer: ${raw}`);

			expect(wakesByRule(raw), raw).toBe(steerWakes(steer));
		}
	});

	// 85PKB2, 14 November: an act added to the mesh but not to the rule
	// would leave a parked peer asleep without anyone choosing it.
	it("judges every act the mesh knows on purpose", () => {
		const leftParked = ["pause", "resume", "stop"];

		expect([...WAKING_STEERS.acts, ...leftParked].sort()).toEqual(
			[...STEER_ACTS, ORDERED_CARRY].sort(),
		);
	});

	it("names each of a peer's inboxes beside the rule", () => {
		expect(holderSteers("/state/steer", ["85PKB2", "8859FF67"])).toEqual({
			inboxes: [
				inboxOf("/state/steer", "85PKB2"),
				inboxOf("/state/steer", "8859FF67"),
			],
			wakes: WAKING_STEERS,
		});
	});
});

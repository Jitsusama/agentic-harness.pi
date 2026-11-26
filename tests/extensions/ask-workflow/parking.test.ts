import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ask from "../../../extensions/ask-workflow/index.ts";
import {
	absence,
	type ParkReason,
	parkedPointing,
	parkedText,
	parkQuestions,
	pointerOf,
	watchToPark,
} from "../../../extensions/ask-workflow/parking.ts";
import { resetAway } from "../../../lib/internal/away/state.ts";
import { stateDir } from "../../../lib/internal/paths.ts";
import { looksIn, refusalOf } from "../../../lib/mesh/looks/looks.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "ask-parking-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/**
 * A mesh presence for `session` signing as `address`, and a quest record
 * saying it has `quest` loaded, under the state folder `state`.
 */
function onTheMesh(
	state: string,
	session: string,
	address: string,
	quest: string,
): { presences: string; sessions: string } {
	const presences = join(state, "mesh-workflow", "presence");
	const sessions = join(state, "quest-workflow", "sessions");
	createPresences(presences).publish({
		session,
		addresses: [address],
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
	});
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, `${session}.json`), JSON.stringify({ quest }));
	return { presences, sessions };
}

/** A runtime folder whose shell says `locked` and `away` as given. */
function runtime(markers: { locked?: string; away?: string }): string {
	if (markers.locked !== undefined)
		writeFileSync(join(scratch, "quickshell-locked"), `${markers.locked}\n`);
	if (markers.away !== undefined)
		writeFileSync(join(scratch, "quickshell-away"), `${markers.away}\n`);
	return scratch;
}

describe("whether the person can answer", () => {
	it("is locked out while the shell's lock is up", () => {
		expect(absence(runtime({ locked: "locked", away: "here" }))).toBe("locked");
	});

	it("is away when the shell says so", () => {
		expect(absence(runtime({ locked: "unlocked", away: "away" }))).toBe("away");
	});

	it("is there when the shell says nothing, or nothing it knows", () => {
		expect(absence(scratch), "no markers").toBeUndefined();
		expect(
			absence(runtime({ locked: "unlocked", away: "maybe" })),
			"an unknown word",
		).toBeUndefined();
		expect(absence(undefined), "no runtime folder").toBeUndefined();
	});
});

describe("when a question on screen parks", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("parks once it has stood unanswered the whole while", () => {
		const parks: ParkReason[] = [];
		watchToPark((reason) => parks.push(reason), {
			afterMs: 300_000,
			everyMs: 15_000,
			absent: () => undefined,
		});
		vi.advanceTimersByTime(299_999);
		expect(parks, "parked early").toEqual([]);
		vi.advanceTimersByTime(1);
		expect(parks).toEqual(["unanswered"]);
		vi.advanceTimersByTime(600_000);
		expect(parks, "parked twice").toEqual(["unanswered"]);
	});

	it("parks as soon as it sees the person has gone", () => {
		const parks: ParkReason[] = [];
		let gone: "locked" | undefined;
		watchToPark((reason) => parks.push(reason), {
			afterMs: 300_000,
			everyMs: 15_000,
			absent: () => gone,
		});
		vi.advanceTimersByTime(30_000);
		gone = "locked";
		vi.advanceTimersByTime(15_000);
		expect(parks).toEqual(["locked"]);
	});

	it("parks nothing once its question ends", () => {
		const parks: ParkReason[] = [];
		const stop = watchToPark((reason) => parks.push(reason), {
			afterMs: 300_000,
			everyMs: 15_000,
			absent: () => "away",
		});
		stop();
		vi.advanceTimersByTime(600_000);
		expect(parks).toEqual([]);
	});
});

const QUESTION = {
	prompt: "Ship the status bar change tonight?",
	options: [{ label: "Ship it" }, { label: "Wait for Monday" }],
};

describe("what the look list is told", () => {
	it("carries a short question's words and choices, opening its window", () => {
		const pointing = parkedPointing("s1", [QUESTION], "unanswered");
		expect(pointing).toMatchObject({
			kind: "terminal",
			target: "s1",
			ask: QUESTION.prompt,
			choices: ["Ship it", "Wait for Monday"],
		});
		expect(refusalOf(pointing), "the look list refused it").toBeUndefined();
	});

	it("keeps the choices but not words a look can't carry", () => {
		const pointing = parkedPointing(
			"s1",
			[{ ...QUESTION, prompt: "Merge `jitsusama/x` now?" }],
			"locked",
		);
		expect(pointing.ask, "code reached the look").not.toContain("`");
		expect(pointing.choices).toEqual(["Ship it", "Wait for Monday"]);
		expect(pointing.why).toContain("screen was locked");
		expect(refusalOf(pointing), "the look list refused it").toBeUndefined();
	});

	it("sends the person to the window when the choices don't fit a look", () => {
		const options = ["a", "b", "c", "d", "e"].map((label) => ({ label }));
		const pointing = parkedPointing("s1", [{ ...QUESTION, options }], "away");
		expect(pointing.choices, "five choices offered").toBeUndefined();
		expect(refusalOf(pointing), "the look list refused it").toBeUndefined();
	});

	it("parks several questions as one look answered in the window", () => {
		const pointing = parkedPointing("s1", [QUESTION, QUESTION], "unanswered");
		expect(pointing.title).toBe("2 questions wait for you");
		expect(pointing.choices).toBeUndefined();
		expect(refusalOf(pointing), "the look list refused it").toBeUndefined();
	});

	it("offers no choices where no pick could find its way back", () => {
		const pointing = parkedPointing("s1", [QUESTION], "unanswered", false);
		expect(pointing.choices, "choices nobody can send back").toBeUndefined();
		expect(pointing.ask).toBe(QUESTION.prompt);
		expect(refusalOf(pointing), "the look list refused it").toBeUndefined();
		const parked = parkQuestions(
			scratch,
			{ session: "s1" },
			[QUESTION],
			"unanswered",
		);
		expect(parked.look?.choices, "a look with no address").toBeUndefined();
		expect(parkedText("unanswered", parked)).toContain("opening this window");
	});

	it("names the session's address and quest, where the launcher sends a pick", () => {
		const records = onTheMesh(join(scratch, "state"), "s1", "ABC123", "Q-1");
		expect(pointerOf("s1", records)).toEqual({
			session: "s1",
			address: "ABC123",
			quest: "Q-1",
		});
		expect(pointerOf("s2", records), "a session off the mesh").toEqual({
			session: "s2",
		});
	});

	it("keeps the look for the launcher, asking for an answer", () => {
		const parked = parkQuestions(
			scratch,
			{ session: "s1", address: "ABC123", quest: "Q-1" },
			[QUESTION],
			"unanswered",
		);
		const [look] = looksIn(scratch);
		expect(parked.look?.id).toBe(look?.id);
		expect(look).toMatchObject({
			session: "s1",
			address: "ABC123",
			quest: "Q-1",
			kind: "terminal",
			asks: true,
			state: "waiting",
		});
		expect(look?.choices?.map((one) => one.label)).toEqual([
			"Ship it",
			"Wait for Monday",
		]);
	});

	it("tells the asker nothing was decided", () => {
		const parked = parkQuestions(
			scratch,
			{ session: "s1", address: "ABC123" },
			[QUESTION],
			"away",
		);
		const text = parkedText("away", parked);
		expect(text).toMatch(/^Parked, unanswered: the person is away/);
		expect(text).toContain("take no recommendation");
		expect(text).toContain("arrives later as a message");
	});
});

describe("the ask tool with nobody there", () => {
	const saved = {
		runtime: process.env.XDG_RUNTIME_DIR,
		state: process.env.XDG_STATE_HOME,
	};

	beforeEach(() => {
		resetAway();
		process.env.XDG_RUNTIME_DIR = runtime({ locked: "locked" });
		process.env.XDG_STATE_HOME = join(scratch, "state");
		onTheMesh(stateDir(""), "s1", "ABC123", "Q-1");
	});

	afterEach(() => {
		process.env.XDG_RUNTIME_DIR = saved.runtime;
		process.env.XDG_STATE_HOME = saved.state;
		if (saved.runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
		if (saved.state === undefined) delete process.env.XDG_STATE_HOME;
	});

	type Handler = (event: unknown, ctx: unknown) => unknown;
	const ctx = { hasUI: true, sessionManager: { getSessionId: () => "s1" } };

	/** The ask tool's execute, and its handlers by event, as pi would hold them. */
	function loaded(): {
		execute: (...args: unknown[]) => Promise<unknown>;
		handlers: Map<string, Handler>;
	} {
		let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
		const handlers = new Map<string, Handler>();
		ask({
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerTool: (tool: { execute: typeof execute }) => {
				execute = tool.execute;
			},
		} as unknown as ExtensionAPI);
		if (execute === undefined) throw new Error("no ask tool registered");
		return { execute, handlers };
	}

	/** Ask `execute` one question, with the screen as the test set it. */
	function askShip(
		execute: (...args: unknown[]) => Promise<unknown>,
	): Promise<unknown> {
		return execute(
			"t1",
			{
				questions: [
					{
						id: "ship",
						prompt: QUESTION.prompt,
						options: [
							{ value: "ship", label: "Ship it" },
							{ value: "wait", label: "Wait for Monday" },
						],
						recommended: "ship",
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);
	}

	// WCJQSG for Joel, 25 November: seven parked questions stood on his
	// list back to 15 November, their sessions long since on other work.
	it("takes its parked question off the list once the session starts new work", async () => {
		const { execute, handlers } = loaded();
		await askShip(execute);
		expect(looksIn(stateDir("looks"))[0]?.state, "parked").toBe("waiting");

		await handlers.get("before_agent_start")?.({}, ctx);

		expect(looksIn(stateDir("looks"))[0]).toMatchObject({
			state: "resolved",
			how: "its session carried on",
		});
	});

	it("leaves its parked question standing through a run its host carries on", async () => {
		const { execute, handlers } = loaded();
		await askShip(execute);

		await handlers.get("before_agent_start")?.(
			{ messageType: "continue" },
			ctx,
		);

		expect(looksIn(stateDir("looks"))[0]?.state).toBe("waiting");
	});

	it("reads the list at a run's start only while it may have parked one", async () => {
		const { execute, handlers } = loaded();
		await handlers.get("before_agent_start")?.({}, ctx);
		await askShip(execute);
		const start = handlers.get("before_agent_start");

		await start?.({}, ctx);
		expect(looksIn(stateDir("looks"))[0]?.state, "taken back").toBe("resolved");
		const look = looksIn(stateDir("looks"))[0];
		const file = join(stateDir("looks"), `${look?.id}.json`);
		writeFileSync(file, JSON.stringify({ ...look, state: "waiting" }));
		await start?.({}, ctx);

		expect(
			looksIn(stateDir("looks"))[0]?.state,
			"nothing parked since, so not read",
		).toBe("waiting");
	});

	it("parks at once, taking no recommendation, while the screen is locked", async () => {
		const { execute } = loaded();
		const result = (await execute(
			"t1",
			{
				questions: [
					{
						id: "ship",
						prompt: QUESTION.prompt,
						options: [
							{ value: "ship", label: "Ship it" },
							{ value: "wait", label: "Wait for Monday" },
						],
						recommended: "ship",
					},
				],
			},
			undefined,
			undefined,
			ctx,
		)) as { content: { text: string }[]; details: { parked?: string } };
		const text = result.content[0]?.text ?? "";
		expect(text).toMatch(/^Parked, unanswered: the person's screen is locked/);
		expect(text, "a recommendation was taken").not.toContain(
			"took your recommendation",
		);
		expect(result.details.parked).toBe("locked");
		expect(
			looksIn(stateDir("looks")).map((look) => [look.session, look.address]),
			"nothing reached the look list, or without its address",
		).toEqual([["s1", "ABC123"]]);
	});
});

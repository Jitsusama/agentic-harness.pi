/**
 * Watching a session for the still moment it may park, and parking it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mayPark,
	type Parkable,
	watch,
} from "../../../extensions/park-workflow/watch.ts";
import {
	isParkAsk,
	isParking,
	NAMED_PARK_AFTER_MS,
	PARK_ASK,
	PARKED_EXIT,
	PARKING,
	parkSwitch,
	readParked,
	writeParked,
} from "../../../lib/internal/session/park.ts";
import { announceJobHost } from "../../../lib/jobs/index.ts";

const SESSION = "01a1af3c-26bc-7b80-990f-37848859ff67";

let folder: string;
let events: EventBus;
let clock: number;
let shutdowns: number;
let exits: number[];
let typed: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "park-watch-"));
	events = createEventBus();
	clock = 0;
	shutdowns = 0;
	exits = [];
	typed = "";
	writeFileSync(parkSwitch(folder), `${SESSION}\n`);
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const session = (over: Partial<Parkable> = {}): Parkable => ({
	hasUI: true,
	cwd: "/src/agentic-harness.pi",
	isIdle: () => true,
	hasPendingMessages: () => false,
	shutdown: () => {
		shutdowns += 1;
	},
	ui: { getEditorText: () => typed },
	sessionManager: {
		getSessionId: () => SESSION,
		getSessionFile: () => "/logs/session.jsonl",
	} as unknown as Parkable["sessionManager"],
	...over,
});

const watching = (ctx: Parkable = session()) =>
	watch(ctx, events, {
		env: { MYCELIUM_WAKE: join(folder, "held.wake") },
		switchPath: parkSwitch(folder),
		folder,
		now: () => clock,
		exitWith: (code) => exits.push(code),
		clock: false,
	});

describe("parking a session", () => {
	it("parks one idle past its time, with what the mesh says of it, exiting for its holder", () => {
		events.on(PARKING, (data) => {
			if (!isParking(data)) return;
			data.addresses = ["85PKB2", "8859FF67"];
			data.quest = "QEST-20261025-85PKB2";
		});
		const watched = watching();
		clock = NAMED_PARK_AFTER_MS - 1;
		expect(watched.look()).toBe("not idle long enough");
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(readParked(SESSION, folder)).toMatchObject({
			session: SESSION,
			sessionFile: "/logs/session.jsonl",
			cwd: "/src/agentic-harness.pi",
			addresses: ["85PKB2", "8859FF67"],
			quest: "QEST-20261025-85PKB2",
			wake: join(folder, "held.wake"),
		});
		expect(exits).toEqual([PARKED_EXIT]);
		expect(shutdowns).toBe(1);
		// Asked again before pi has gone, it doesn't park twice.
		expect(watched.look()).toBe("parking already");
		expect(shutdowns).toBe(1);
	});

	it("counts idle from the last thing that happened in it", () => {
		const watched = watching();
		clock = NAMED_PARK_AFTER_MS;
		watched.stirred();
		clock = NAMED_PARK_AFTER_MS * 2 - 1;
		expect(watched.look()).toBe("not idle long enough");
	});

	it("stays while a background job is out, a prompt is open or text is typed", () => {
		const watched = watching();
		clock = NAMED_PARK_AFTER_MS;
		const stop = announceJobHost(events, {
			start: () => {
				throw new Error("not started here");
			},
			pending: () => 1,
		});
		expect(watched.look()).toBe("background jobs are out");
		stop();
		typed = "half a thought";
		expect(watched.look()).toBe("text is typed and unsent");
		typed = "";
		watched.prompting(true);
		clock += NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBe("a prompt is open");
		expect(shutdowns).toBe(0);
	});

	it("stays for what another extension says it holds", () => {
		events.on(PARK_ASK, (data) => {
			if (isParkAsk(data)) data.refusals.push("peers wait on a hold it sent");
		});
		const watched = watching();
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBe("peers wait on a hold it sent");
		expect(shutdowns).toBe(0);
	});

	it("clears the marker an earlier park left, as it starts again", () => {
		writeParked(
			{
				session: SESSION,
				sessionFile: "/logs/session.jsonl",
				cwd: "/src",
				addresses: [],
				parkedAt: "2026-11-06T16:00:00.000Z",
				pid: 1,
				wake: join(folder, "held.wake"),
			},
			folder,
		);
		watching();
		expect(readParked(SESSION, folder)).toBeUndefined();
	});
});

describe("which sessions may park", () => {
	it("is only one its person sees, not a subagent, kept by a holder that wakes it", () => {
		const wake = { MYCELIUM_WAKE: "/run/user/1000/mycelium/work.held/x.wake" };
		expect(mayPark({ hasUI: true }, wake)).toBe(true);
		expect(mayPark({ hasUI: true }, {})).toBe(false);
		expect(mayPark({ hasUI: false }, wake)).toBe(false);
		expect(mayPark({ hasUI: true }, { ...wake, SUBAGENT_RUN_ID: "r" })).toBe(
			false,
		);
	});
});

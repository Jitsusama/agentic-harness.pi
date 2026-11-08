/**
 * Watching a session for the still moment it may park, and parking it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	flagsLost,
	isParkAsk,
	isParking,
	NAMED_PARK_AFTER_MS,
	opensOnlyItself,
	PARK_ASK,
	PARKED_EXIT,
	PARKING,
	parkSwitch,
	readParked,
	SESSION_WOKEN,
	writeParked,
} from "../../../lib/internal/session/park.ts";
import { announceJobHost } from "../../../lib/jobs/index.ts";

const SESSION = "01a1af3c-26bc-7b80-990f-37848859ff67";
/** The process the holder's record says it runs. */
const HELD_PID = 4242;

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
	writeFileSync(join(folder, "held.json"), JSON.stringify({ pid: HELD_PID }));
	writeFileSync(logOf(), "");
});

/** The session's log, written as pi writes it at its first answer. */
const logOf = () => join(folder, "session.jsonl");

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
		getSessionFile: () => logOf(),
	} as unknown as Parkable["sessionManager"],
	...over,
});

const holder = () => ({
	MYCELIUM_WAKE: join(folder, "held.wake"),
	MYCELIUM_AGAIN: join(folder, "held.again"),
});

const watching = (
	ctx: Parkable = session(),
	env: NodeJS.ProcessEnv = holder(),
	args: readonly string[] = [],
) =>
	watch(ctx, events, {
		env,
		args,
		pid: HELD_PID,
		switchPath: parkSwitch(folder),
		folder,
		now: () => clock,
		exitWith: (code) => exits.push(code),
		clock: false,
	});

describe("parking a session", () => {
	it("parks one idle past its time, with what the mesh says of it, exiting for its holder", () => {
		const wakes: (string | undefined)[] = [];
		events.on(PARKING, (data) => {
			if (!isParking(data)) return;
			wakes.push(data.wake);
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
			sessionFile: logOf(),
			cwd: "/src/agentic-harness.pi",
			addresses: ["85PKB2", "8859FF67"],
			quest: "QEST-20261025-85PKB2",
			wake: join(folder, "held.wake"),
		});
		// The mesh is told the wake too, to say in its presence.
		expect(wakes).toEqual([join(folder, "held.wake")]);
		expect(exits).toEqual([PARKED_EXIT]);
		expect(shutdowns).toBe(1);
		// Asked again before pi has gone, it doesn't park twice.
		expect(watched.look()).toBe("parking already");
		expect(shutdowns).toBe(1);
	});

	it("names its holder the command that opens its log, to wake with", () => {
		const watched = watching();
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(
			JSON.parse(readFileSync(join(folder, "held.again"), "utf8")),
		).toEqual(["pi", "--session", logOf()]);
	});

	it("stays while its log isn't written, which pi does at its first answer", () => {
		rmSync(logOf());
		const watched = watching();
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBe("its log isn't written yet");
		expect(shutdowns).toBe(0);
	});

	it("stays when starting again would drop a flag it was started with", () => {
		const watched = watching(session(), holder(), ["-e", "./x.ts", "--", "hi"]);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBe("starting again would drop -e");
		expect(shutdowns).toBe(0);
	});

	it("stays under a holder naming no restart unless pi was started on itself", () => {
		const { MYCELIUM_WAKE } = holder();
		const bare = watching(session(), { MYCELIUM_WAKE }, ["--", "hello"]);
		const resumed = watching(session(), { MYCELIUM_WAKE }, [
			"--session-id",
			SESSION,
		]);
		clock = NAMED_PARK_AFTER_MS;
		expect(bare.look()).toBe("its holder would start it as a new session");
		expect(shutdowns).toBe(0);
		expect(resumed.look()).toBeUndefined();
		expect(exits).toEqual([PARKED_EXIT]);
	});

	it("stays when its holder runs it through another program, such as a shell", () => {
		writeFileSync(join(folder, "held.json"), JSON.stringify({ pid: 1 }));
		const watched = watching();
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBe("its holder runs it through another program");
		rmSync(join(folder, "held.json"));
		expect(watched.look()).toBe("its holder runs it through another program");
		expect(shutdowns).toBe(0);
	});

	it("counts idle from its log's last message when it starts, as on a reload", () => {
		clock = NAMED_PARK_AFTER_MS * 10;
		const at = (ms: number) => new Date(ms).toISOString();
		const logged = session({
			sessionManager: {
				getSessionId: () => SESSION,
				getSessionFile: () => logOf(),
				getBranch: () => [
					{ type: "message", timestamp: at(clock - NAMED_PARK_AFTER_MS) },
					// A mesh note since is no sign of life.
					{ type: "custom_message", timestamp: at(clock - 1) },
				],
			} as unknown as Parkable["sessionManager"],
		});
		expect(watching(logged).look()).toBeUndefined();
		expect(exits).toEqual([PARKED_EXIT]);
	});

	it("counts idle from its start when a park just ended, so a key that woke it holds", () => {
		clock = NAMED_PARK_AFTER_MS * 10;
		writeParked(
			{
				session: SESSION,
				sessionFile: logOf(),
				cwd: "/src",
				addresses: [],
				parkedAt: new Date(0).toISOString(),
				pid: 1,
				wake: join(folder, "held.wake"),
			},
			folder,
		);
		const logged = session({
			sessionManager: {
				getSessionId: () => SESSION,
				getSessionFile: () => logOf(),
				getBranch: () => [
					{ type: "message", timestamp: new Date(0).toISOString() },
				],
			} as unknown as Parkable["sessionManager"],
		});
		expect(watching(logged).look()).toBe("not idle long enough");
		expect(shutdowns).toBe(0);
	});

	it("says it woke from a park, and says nothing on any other start", () => {
		const woken: unknown[] = [];
		events.on(SESSION_WOKEN, (data) => woken.push(data));
		watching().stop();
		expect(woken).toEqual([]);

		writeParked(
			{
				session: SESSION,
				sessionFile: logOf(),
				cwd: "/src",
				addresses: [],
				parkedAt: new Date(0).toISOString(),
				pid: 1,
				wake: join(folder, "held.wake"),
			},
			folder,
		);
		watching().stop();

		expect(woken).toEqual([{ session: SESSION }]);
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

describe("whether pi's arguments open a session", () => {
	const log = "/logs/session.jsonl";
	it("opens only itself by its id or its log, spaced or joined", () => {
		expect(
			opensOnlyItself(["--session", log], SESSION, log),
			"--session <log>",
		).toBe(true);
		expect(
			opensOnlyItself([`--session=${log}`], SESSION, log),
			"--session=<log>",
		).toBe(true);
		expect(
			opensOnlyItself(["--session-id", SESSION], SESSION, log),
			"--session-id <id>",
		).toBe(true);
		expect(opensOnlyItself([], SESSION, log), "no arguments").toBe(false);
		expect(
			opensOnlyItself(["--session", "other"], SESSION, log),
			"--session naming another session",
		).toBe(false);
		expect(
			opensOnlyItself(["--", "--session", log], SESSION, log),
			"--session after --, which is a prompt",
		).toBe(false);
	});

	it("is not only itself with a prompt, which would be sent again", () => {
		expect(
			opensOnlyItself(["--session", log, "hi"], SESSION, log),
			"--session <log> with a prompt",
		).toBe(false);
		expect(
			opensOnlyItself([`--session=${log}`, "hi"], SESSION, log),
			"--session=<log> with a prompt",
		).toBe(false);
	});

	it("loses the flags a restart wouldn't give again, not a prompt or its session", () => {
		expect(flagsLost(["--", "-e", "hi"])).toEqual([]);
		expect(flagsLost(["--session", log, "hi"])).toEqual([]);
		expect(flagsLost(["-e", "x.ts", "--model=m"])).toEqual(["-e", "--model"]);
	});
});

describe("which sessions may park", () => {
	it("is only one its person sees, not a subagent, kept by a holder that wakes it", () => {
		const wake = { MYCELIUM_WAKE: "/run/user/1000/mycelium/work.held/x.wake" };
		expect(
			mayPark({ hasUI: true }, wake),
			"a seen session a holder wakes",
		).toBe(true);
		expect(mayPark({ hasUI: true }, {}), "a seen session nothing wakes").toBe(
			false,
		);
		expect(mayPark({ hasUI: false }, wake), "a session with no UI").toBe(false);
		expect(
			mayPark({ hasUI: true }, { ...wake, SUBAGENT_RUN_ID: "r" }),
			"a subagent",
		).toBe(false);
	});
});

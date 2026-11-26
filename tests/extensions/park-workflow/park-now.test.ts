/**
 * The park watch parking its session now, as its person's Park from
 * outside the window asks on the bus: idle time counts for nothing,
 * everything else that holds a park still does.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAILED_PARK_HOLDS_MS } from "../../../extensions/park-workflow/undo.ts";
import {
	type Parkable,
	watch,
} from "../../../extensions/park-workflow/watch.ts";
import {
	PARK_REFUSED_EVENT,
	type ParkRefused,
} from "../../../lib/core/session/host.ts";
import { installHost } from "../../../lib/core/session/index.ts";
import { RUN_UNDER_WAY } from "../../../lib/internal/session/free.ts";
import {
	awakePath,
	isParkAsk,
	PARK_ASK,
	PARK_NOW_ASK,
	PARK_UNDONE,
	PARKED_EXIT,
	type ParkNowAsk,
	parkSwitch,
	readParked,
} from "../../../lib/internal/session/park.ts";
import type { Desk } from "../../../lib/internal/session/park-desktop.ts";

const SESSION = "01a1af3c-26bc-7b80-990f-37848859ff67";
/** The process the holder's record says it runs. */
const HELD_PID = 4242;
const SOCKET = "unix:/run/user/1000/pi-sessions/kitty.sock";
const CLOSE = `kitten @ --to ${SOCKET} close-window --match id:33`;

let folder: string;
let events: EventBus;
let exits: number[];
let typed: string;
let idle: boolean;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "park-now-"));
	events = createEventBus();
	exits = [];
	typed = "";
	idle = true;
	writeFileSync(parkSwitch(folder), "on\n");
	writeFileSync(join(folder, "held.json"), JSON.stringify({ pid: HELD_PID }));
	writeFileSync(join(folder, "session.jsonl"), "");
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const session = (): Parkable => ({
	hasUI: true,
	cwd: "/src/agentic-harness.pi",
	isIdle: () => idle,
	hasPendingMessages: () => false,
	shutdown: () => {},
	ui: { getEditorText: () => typed },
	sessionManager: {
		getSessionId: () => SESSION,
		getSessionFile: () => join(folder, "session.jsonl"),
	} as unknown as Parkable["sessionManager"],
});

const holder = (): NodeJS.ProcessEnv => ({
	MYCELIUM_WAKE: join(folder, "held.wake"),
	MYCELIUM_AGAIN: join(folder, "held.again"),
});

const watching = (env: NodeJS.ProcessEnv = holder(), desk?: Desk) =>
	watch(session(), events, {
		env,
		args: [],
		pid: HELD_PID,
		switchPath: parkSwitch(folder),
		folder,
		// Its log was written a moment ago: by the usual rule it is far
		// from due.
		now: () => 1_000,
		exitWith: (code) => exits.push(code),
		clock: false,
		...(desk === undefined ? {} : { desk }),
	});

/** Ask on the bus, as the mesh's pausing does, answering what came back. */
const ask = (session = SESSION, check = false): ParkNowAsk => {
	const asked: ParkNowAsk = { session, ...(check ? { check } : {}) };
	events.emit(PARK_NOW_ASK, asked);
	return asked;
};

describe("parking now, as the person asked", () => {
	it("parks a session just idle, for its holder, its marker saying no rule's wait", () => {
		const watched = watching();
		expect(watched.look(), "the rule would wait").toBe("not idle long enough");

		expect(ask()).toEqual({ session: SESSION, parked: true });
		expect(exits).toEqual([PARKED_EXIT]);
		expect(readParked(SESSION, folder)?.afterMs).toBe(0);
	});

	it("answers why not where something of its own still holds it", () => {
		watching();
		typed = "half a thought";

		expect(ask()).toEqual({
			session: SESSION,
			why: "text is typed and unsent",
		});
		expect(exits).toEqual([]);
		expect(readParked(SESSION, folder)).toBeUndefined();
	});

	it("answers that a run is under way, mid-run", () => {
		watching();
		idle = false;

		expect(ask().why).toBe(RUN_UNDER_WAY);
		expect(exits).toEqual([]);
	});

	it("asks the other extensions what holds it, and keeps what they say", () => {
		events.on(PARK_ASK, (data) => {
			if (isParkAsk(data)) data.refusals.push("peers wait on a hold it sent");
		});
		watching();

		expect(ask().why).toBe("peers wait on a hold it sent");
		expect(exits).toEqual([]);
	});

	it("refuses where parking is off", () => {
		writeFileSync(parkSwitch(folder), "");
		watching();

		expect(ask().why).toBe("parking is off");
		expect(exits).toEqual([]);
	});

	it("leaves another session's ask to that session", () => {
		watching();

		expect(ask("01a1af3c-0000-7b80-990f-000000000000")).toEqual({
			session: "01a1af3c-0000-7b80-990f-000000000000",
		});
		expect(exits).toEqual([]);
	});

	// Asked mid-run, before the run is stopped for the park.
	it("checks mid-run without parking, counting the run as settled", () => {
		watching();
		idle = false;

		expect(ask(SESSION, true)).toEqual({
			session: SESSION,
			check: true,
			ready: true,
		});
		expect(exits).toEqual([]);
		expect(readParked(SESSION, folder)).toBeUndefined();
		expect(
			existsSync(join(folder, "held.again")),
			"its holder told nothing",
		).toBe(false);
		expect(existsSync(join(folder, "held.wake")), "nothing woken").toBe(false);
	});

	it("checks mid-run what would still hold it once its run settles", () => {
		watching();
		idle = false;
		typed = "half a thought";

		expect(ask(SESSION, true).why).toBe("text is typed and unsent");
		expect(exits).toEqual([]);
	});

	// Fixed by how it was started, so the park at the run's end would
	// refuse it for certain: a check that said ready stopped the run for
	// nothing.
	it("checks mid-run that starting again would keep its flags", () => {
		watch(session(), events, {
			env: holder(),
			args: ["-e", "./x.ts"],
			pid: HELD_PID,
			switchPath: parkSwitch(folder),
			folder,
			now: () => 1_000,
			exitWith: (code) => exits.push(code),
			clock: false,
		});
		idle = false;

		expect(ask(SESSION, true).why).toMatch(/^starting again would drop -e/);
		expect(
			existsSync(join(folder, "held.again")),
			"no again file is written mid-run",
		).toBe(false);
	});

	it("checks mid-run that its holder would start it as itself", () => {
		watching({ ...holder(), MYCELIUM_AGAIN: "" });
		idle = false;

		expect(ask(SESSION, true).why).toBe(
			"its holder would start it as a new session",
		);
	});

	// Its run's first answer writes the log the park then starts from.
	it("checks mid-run without asking for a log its run has yet to write", () => {
		rmSync(join(folder, "session.jsonl"));
		watching();
		idle = false;

		expect(ask(SESSION, true).ready, "the check is ready without the log").toBe(
			true,
		);
	});

	// A context gone stale throws as pi is shut down, after its holder was
	// told and its exit code said.
	it("takes back a park whose end fails, holding the clock's next while a later ask parks it", () => {
		const parked = join(folder, "held.parked");
		const undone: unknown[] = [];
		events.on(PARK_UNDONE, (data) => undone.push(data));
		let stale = true;
		let now = 1_000;
		const stalling: Parkable = {
			...session(),
			shutdown: () => {
				if (stale) throw new Error("this context is stale");
			},
		};
		const watched = watch(stalling, events, {
			env: { ...holder(), MYCELIUM_PARKED: parked },
			args: [],
			pid: HELD_PID,
			switchPath: parkSwitch(folder),
			folder,
			now: () => now,
			exitWith: (code) => exits.push(code),
			clock: false,
		});

		expect(ask().why).toBe("its park failed: this context is stale");
		expect(
			readParked(SESSION, folder),
			"its marker taken back",
		).toBeUndefined();
		expect(existsSync(parked), "its holder untold").toBe(false);
		expect(undone).toEqual([{ session: SESSION }]);

		// Idle long past its rule's wait, yet held.
		now += FAILED_PARK_HOLDS_MS - 1;
		expect(watched.look(), "its clock waits rather than fail again").toBe(
			"its last park failed, so it tries again half an hour on: this context is stale",
		);

		stale = false;
		expect(ask().parked, "its person's Park tries at once").toBe(true);
		// This fake keeps each code it was told; pi's own exitWith is taken
		// back as the park is (undo.test.ts).
		expect(exits).toEqual([PARKED_EXIT, PARKED_EXIT]);
		expect(
			existsSync(parked),
			`its holder is told by the retry: ${parked}`,
		).toBe(true);
	});

	// A host parks the conversation alone, after its marker and its word
	// to the mesh: a host that refuses leaves them to be taken back.
	it("takes back a park its host refused, leaving its process to run", () => {
		const undone: unknown[] = [];
		events.on(PARK_UNDONE, (data) => undone.push(data));
		const parks: string[] = [];
		let refuses = true;
		const uninstall = installHost({
			kind: "pi-durable",
			key: "test-park-now-background",
			owner: { pid: process.pid, startedAt: 1 },
			holds: () => "idle",
			env: () => {
				throw new Error("a park reads no host environment");
			},
			hints: () => ({}),
			close: () => {},
			stamp: () => {},
			park: (id) => {
				if (refuses) throw new Error("its host is restarting");
				parks.push(id);
			},
		});
		// Taken out within the test, since the teardown after each test
		// reads no session while a host is in.
		try {
			watching();

			expect(ask().why).toBe("its park failed: its host is restarting");
			expect(
				readParked(SESSION, folder),
				"its marker taken back",
			).toBeUndefined();
			expect(undone).toEqual([{ session: SESSION }]);
			expect(exits, "its process was never to exit").toEqual([]);

			refuses = false;
			expect(
				ask().parked,
				"once its host takes parks, the next ask parks it",
			).toBe(true);
			expect(parks).toEqual([SESSION]);
		} finally {
			uninstall();
		}
	});

	// A host parks once the asking call returns, so its refusal comes later, on the bus.
	it("takes back a park its host refuses after the asking call returned", () => {
		const undone: unknown[] = [];
		events.on(PARK_UNDONE, (data) => undone.push(data));
		const parks: string[] = [];
		const uninstall = installHost({
			kind: "pi-durable",
			key: "test-park-now-background",
			owner: { pid: process.pid, startedAt: 1 },
			holds: () => "idle",
			env: () => {
				throw new Error("a park reads no host environment");
			},
			hints: () => ({}),
			close: () => {},
			stamp: () => {},
			park: (id) => {
				parks.push(id);
			},
		});
		try {
			const watched = watching();
			// #2249 F3: a refusal while it isn't parking takes nothing back and
			// holds no clock, as a late one from an earlier park would be.
			const early: ParkRefused = { session: SESSION, why: "no park asked" };
			events.emit(PARK_REFUSED_EVENT, early);
			expect(undone, "nothing to take back").toEqual([]);
			expect(watched.look(), "no failure holds its clock").toBe(
				"not idle long enough",
			);

			expect(ask().parked, "the host took the ask").toBe(true);
			expect(readParked(SESSION, folder)).toBeDefined();

			const other: ParkRefused = { session: "another", why: "not this one" };
			events.emit(PARK_REFUSED_EVENT, other);
			expect(
				readParked(SESSION, folder),
				"another conversation's refusal is not its own",
			).toBeDefined();

			const refused: ParkRefused = {
				session: SESSION,
				why: "its stop threw before it began",
			};
			events.emit(PARK_REFUSED_EVENT, refused);

			expect(
				readParked(SESSION, folder),
				"its marker taken back",
			).toBeUndefined();
			expect(undone).toEqual([{ session: SESSION }]);
			expect(exits, "its process was never to exit").toEqual([]);
			// #2249 F22: the person's Park said parked, so it says why it runs
			// on at once, not at the clock's next look.
			expect(
				JSON.parse(readFileSync(awakePath(SESSION, folder), "utf8")).why,
			).toBe(
				"its last park failed, so it tries again half an hour on: its stop threw before it began",
			);
			expect(ask().parked, "awake again, the person's next Park parks it").toBe(
				true,
			);
			expect(parks).toEqual([SESSION, SESSION]);
		} finally {
			uninstall();
		}
	});

	// A drain waits on this park to restart its host, so a failed one
	// holds only the clock's own tries.
	it("lets a draining host's park try again at once after one failed", () => {
		const parks: string[] = [];
		let refuses = true;
		const uninstall = installHost({
			kind: "pi-durable",
			key: "test-park-now-draining",
			owner: { pid: process.pid, startedAt: 1 },
			holds: () => "idle",
			env: () => {
				throw new Error("a park reads no host environment");
			},
			hints: () => ({}),
			close: () => {},
			stamp: () => {},
			draining: () => true,
			park: (id) => {
				if (refuses) throw new Error("its host is restarting");
				parks.push(id);
			},
		});
		try {
			const watched = watching();
			expect(ask().why).toBe("its park failed: its host is restarting");

			refuses = false;
			watched.look();

			expect(parks, "its drain's park went").toEqual([SESSION]);
		} finally {
			uninstall();
		}
	});

	it("answers nothing once its watch has stopped", () => {
		watching().stop();

		expect(ask()).toEqual({ session: SESSION });
	});

	it("parks with its window on a workspace in sight, leaving that window open", () => {
		writeFileSync(
			join(folder, "held.json"),
			JSON.stringify({
				pid: HELD_PID,
				windows: [
					{
						terminal: "kitty",
						id: "33",
						within: SOCKET,
						app_id: "pi-session.1",
					},
				],
			}),
		);
		const calls: string[] = [];
		const run = (program: string, args: readonly string[]) => {
			const call = [program, ...args].join(" ");
			calls.push(call);
			if (call === "niri msg --json windows") {
				return JSON.stringify([
					{ id: 7, app_id: "pi-session.1", workspace_id: 1, is_focused: false },
				]);
			}
			if (call === "niri msg --json focused-window") return "null";
			if (call === "niri msg --json workspaces") {
				return JSON.stringify([
					{ id: 1, is_active: true, is_focused: true, output: "eDP-1" },
				]);
			}
			if (program === "qs") return "kept";
			if (call.startsWith(`kitten @ --to ${SOCKET} ls --match id:`)) {
				return JSON.stringify([
					{ wm_class: "pi-session.1", tabs: [{ windows: [{ id: 33 }] }] },
				]);
			}
			return "";
		};
		watching(
			{ ...holder(), NIRI_SOCKET: "/run/niri.sock" },
			{ run, memory: join(folder, "screen.json") },
		);

		expect(ask().parked, "only the rule waits for it out of sight").toBe(true);
		expect(exits).toEqual([PARKED_EXIT]);
		expect(calls, "a window its person can see stays").not.toContain(CLOSE);
		expect(readParked(SESSION, folder)?.windows).toEqual({
			closed: [],
			open: "its window is on a workspace in sight",
		});
	});
});

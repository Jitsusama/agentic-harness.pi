/**
 * The park watch parking its session now, as its person's Park from
 * outside the window asks on the bus: idle time counts for nothing,
 * everything else that holds a park still does.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Parkable,
	watch,
} from "../../../extensions/park-workflow/watch.ts";
import { RUN_UNDER_WAY } from "../../../lib/internal/session/free.ts";
import {
	isParkAsk,
	PARK_ASK,
	PARK_NOW_ASK,
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
const ask = (session = SESSION): ParkNowAsk => {
	const asked: ParkNowAsk = { session };
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

/**
 * Watching a session for the still moment it may park, and parking it.
 *
 * Long because parking, closing its window, starting again on a fresh
 * log and why a session stays awake all drive one watcher through the
 * same fake session and clock, which splitting would copy into each.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	HOST_PARKS,
	mayPark,
	noteNeverParks,
	type Parkable,
	replaceInPlace,
	restartEnvironment,
	UNWATCHED_MS,
	watch,
} from "../../../extensions/park-workflow/watch.ts";
import { RUN_UNDER_WAY } from "../../../lib/internal/session/free.ts";
import {
	awakePath,
	BACKGROUND_PARK_AFTER_MS,
	EASE_LASTS_MS,
	EASED_PARK_AFTER_MS,
	easePath,
	flagsLost,
	isParkAsk,
	isParking,
	NAMED_PARK_AFTER_MS,
	OLD_PARK_AFTER_MS,
	OLD_PI_MS,
	opensOnlyItself,
	PARK_AFTER_MS,
	PARK_ASK,
	PARK_SAID_ENV,
	PARKED_EXIT,
	PARKING,
	parkSwitch,
	RESTART_ASK,
	type RestartAsk,
	readParked,
	readWakes,
	SESSION_WOKEN,
	takeBackRestartPark,
	WAKES_KEPT_MS,
	writeParked,
} from "../../../lib/internal/session/park.ts";
import { CALLS_WATCHED_MS } from "../../../lib/internal/shell/carried.ts";
import { WRITING } from "../../../lib/internal/write-whole.ts";
import { announceJobHost } from "../../../lib/jobs/index.ts";
import { installTestHost } from "../../support/session-host.ts";

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
	platform?: NodeJS.Platform,
) =>
	watch(ctx, events, {
		env,
		args,
		...(platform === undefined ? {} : { platform }),
		pid: HELD_PID,
		switchPath: parkSwitch(folder),
		folder,
		now: () => clock,
		exitWith: (code) => exits.push(code),
		clock: false,
	});

describe("parking a session", () => {
	it("parks a pi over a day old sooner, so its wake starts a fresh one", () => {
		writeFileSync(parkSwitch(folder), "on\n");
		const aged = (startedAt: number) =>
			watch(session(), events, {
				env: holder(),
				args: [],
				pid: HELD_PID,
				switchPath: parkSwitch(folder),
				folder,
				now: () => clock,
				startedAt,
				exitWith: (code) => exits.push(code),
				clock: false,
			});
		expect(OLD_PARK_AFTER_MS, "sooner than the usual wait").toBeLessThan(
			PARK_AFTER_MS,
		);
		// Both are watched from now, and looked at once idle long enough.
		const young = aged(OLD_PARK_AFTER_MS - OLD_PI_MS + 1);
		const old = aged(OLD_PARK_AFTER_MS - OLD_PI_MS);
		clock = OLD_PARK_AFTER_MS;
		expect(young.look(), "a day short, it waits as usual").toBe(
			"not idle long enough",
		);
		young.stop();
		expect(old.look(), "a day old, it parks").toBeUndefined();
		expect(old.endedItsProcess(), "parked, it ended pi").toBe(true);
	});

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
		expect(watched.endedItsProcess(), "awake, it ended nothing").toBe(false);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(watched.endedItsProcess(), "parked, it ended pi").toBe(true);
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

	// 21 November, P10876: parked, its exit hung on a name lookup and
	// ended by a signal, so its holder, seeing no 75, let the window go.
	it("tells a holder that names a file for it that the run parked, before pi ends", () => {
		const parked = join(folder, "held.parked");
		const saidAtExit: boolean[] = [];
		let refusing = true;
		events.on(PARK_ASK, (data) => {
			if (refusing && isParkAsk(data)) data.refusals.push("a run is on");
		});
		const watched = watch(session(), events, {
			env: { ...holder(), MYCELIUM_PARKED: parked },
			args: [],
			pid: HELD_PID,
			switchPath: parkSwitch(folder),
			folder,
			now: () => clock,
			exitWith: (code) => {
				saidAtExit.push(existsSync(parked));
				exits.push(code);
			},
			clock: false,
		});
		clock = NAMED_PARK_AFTER_MS - 1;
		expect(watched.look()).toBe("not idle long enough");
		expect(existsSync(parked), "awake, it says nothing").toBe(false);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBe("a run is on");
		expect(existsSync(parked), "refused when due, it says nothing").toBe(false);
		refusing = false;
		expect(watched.look()).toBeUndefined();
		expect(readFileSync(parked, "utf8"), "parked, it says so").toBe("");
		expect(saidAtExit, "said before pi's exit is set").toEqual([true]);
		expect(exits).toEqual([PARKED_EXIT]);
	});

	it("names its holder the command that opens its log, to wake with", () => {
		const watched = watching();
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(
			JSON.parse(readFileSync(join(folder, "held.again"), "utf8")),
		).toEqual(["pi", "--session", logOf()]);
	});

	// 10 November: a restart of old idle sessions was refused for most of
	// them, since their holders had started them with --model.
	it("gives its holder the model flags it was started with, to wake with", () => {
		const watched = watching(session(), holder(), [
			"--session",
			SESSION,
			"--model",
			"anthropic/claude-opus-5-5:high",
			"--thinking=high",
			"--",
			"hi",
		]);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(
			JSON.parse(readFileSync(join(folder, "held.again"), "utf8")),
		).toEqual([
			"pi",
			"--session",
			logOf(),
			"--model",
			"anthropic/claude-opus-5-5:high",
			"--thinking=high",
		]);
	});

	// 11 November: started fenced and through the spawner, 85PKB2 came
	// back from its park with neither, since its holder runs the command
	// in its own environment.
	it("gives its holder the fence and the spawner it was started with, to wake with", () => {
		const watched = watching(session(), {
			...holder(),
			PI_SANDBOX: "fence",
			PI_SPAWNER: "on",
		});
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(
			JSON.parse(readFileSync(join(folder, "held.again"), "utf8")),
		).toEqual([
			"env",
			"PI_SANDBOX=fence",
			"PI_SPAWNER=on",
			"pi",
			"--session",
			logOf(),
		]);
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

describe("closing its window as it parks", () => {
	// Joel, 14 November: "should sessions put to sleep even have windows?"
	// Its holder outlives the window, so a parked pi's window closes, but
	// never one he is at or can see (OSPHT4 [7a47aa8b]).
	const SOCKET = "unix:/run/user/1000/pi-sessions/kitty.sock";
	const CLOSE = `kitten @ --to ${SOCKET} close-window --match id:33`;
	const KEEP = `qs ipc call sessions keepPlaceAsleep ${SESSION}`;
	const onNiri = () => ({ ...holder(), NIRI_SOCKET: "/run/niri.sock" });

	beforeEach(() => {
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
	});

	/** A desktop showing its window on `workspace`; 1 is the one in sight. */
	const desktop = (
		workspace: number,
		given: {
			focused?: boolean;
			kept?: string;
			/** Focused from this read of niri's windows on, counting from 1. */
			focusedFromRead?: number;
			/** niri's windows fail to read from this read on. */
			failsFromRead?: number;
			kittyFails?: boolean;
		} = {},
	) => {
		const calls: string[] = [];
		let reads = 0;
		const run = (program: string, args: readonly string[]) => {
			const call = [program, ...args].join(" ");
			calls.push(call);
			if (call === "niri msg --json windows") {
				reads += 1;
				if (reads >= (given.failsFromRead ?? Number.POSITIVE_INFINITY)) {
					throw new Error("niri is gone");
				}
				const focused =
					(given.focused ?? false) ||
					reads >= (given.focusedFromRead ?? Number.POSITIVE_INFINITY);
				return JSON.stringify([
					{
						id: 7,
						app_id: "pi-session.1",
						workspace_id: workspace,
						is_focused: focused,
					},
				]);
			}
			if (call === "niri msg --json focused-window") return "null";
			if (given.kittyFails && call.includes("close-window")) {
				throw new Error("kitty is gone");
			}
			if (call === "niri msg --json workspaces") {
				return JSON.stringify([
					{ id: 1, is_active: true, is_focused: true, output: "eDP-1" },
					{ id: 3, is_active: false, is_focused: false, output: "eDP-1" },
				]);
			}
			if (program === "qs") return given.kept ?? "kept";
			if (call.startsWith(`kitten @ --to ${SOCKET} ls --match id:`)) {
				return JSON.stringify([
					{ wm_class: "pi-session.1", tabs: [{ windows: [{ id: 33 }] }] },
				]);
			}
			return "";
		};
		return { calls, desk: { run, memory: join(folder, "screen.json") } };
	};

	const parkingOn = (
		desk: ReturnType<typeof desktop>["desk"],
		env: NodeJS.ProcessEnv = onNiri(),
	) =>
		watch(session(), events, {
			env,
			pid: HELD_PID,
			switchPath: parkSwitch(folder),
			folder,
			now: () => clock,
			exitWith: (code) => exits.push(code),
			clock: false,
			desk,
		});

	it("keeps its place asleep, closes its window, then exits for its holder", () => {
		const { calls, desk } = desktop(3);
		const watched = parkingOn(desk);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(calls.indexOf(KEEP)).toBeGreaterThan(-1);
		expect(calls.indexOf(CLOSE)).toBeGreaterThan(calls.indexOf(KEEP));
		expect(exits).toEqual([PARKED_EXIT]);
		expect(shutdowns).toBe(1);
	});

	it("stays awake, saying why, when its window is focused", () => {
		const { calls, desk } = desktop(3, { focused: true });
		const watched = parkingOn(desk);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBe("its window is focused");
		expect(
			JSON.parse(readFileSync(awakePath(SESSION, folder), "utf8")).why,
		).toBe("its window is focused");
		expect(calls).not.toContain(KEEP);
		expect(calls).not.toContain(CLOSE);
		expect(readParked(SESSION, folder)).toBeUndefined();
		expect(exits).toEqual([]);
		expect(shutdowns).toBe(0);
	});

	it("stays awake when its window is on a workspace in sight", () => {
		const { desk } = desktop(1);
		const watched = parkingOn(desk);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBe("its window is on a workspace in sight");
		expect(shutdowns).toBe(0);
	});

	it("parks with its window open when the launcher doesn't keep its place", () => {
		const { calls, desk } = desktop(3, { kept: "no window to keep" });
		const watched = parkingOn(desk);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(calls).not.toContain(CLOSE);
		expect(exits).toEqual([PARKED_EXIT]);
		expect(readParked(SESSION, folder)?.windows).toEqual({
			closed: [],
			open: "the launcher didn't keep its place: no window to keep",
		});
	});

	it("keeps in its marker the windows it closed", () => {
		const { desk } = desktop(3);
		const watched = parkingOn(desk);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(readParked(SESSION, folder)?.windows).toEqual({
			closed: [{ id: "33", appId: "pi-session.1" }],
		});
	});

	it("keeps in its marker why its window stayed open, should it come into sight between the reads", () => {
		const { calls, desk } = desktop(3, { focusedFromRead: 2 });
		const watched = parkingOn(desk);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(calls).not.toContain(CLOSE);
		expect(readParked(SESSION, folder)?.windows).toEqual({
			closed: [],
			open: "its window is focused",
		});
	});

	it("keeps in its marker that niri couldn't be read as it closed", () => {
		const { desk } = desktop(3, { failsFromRead: 2 });
		const watched = parkingOn(desk);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(readParked(SESSION, folder)?.windows).toEqual({
			closed: [],
			open: "niri can't be read",
		});
	});

	it("keeps in its marker that kitty didn't close its window", () => {
		const { desk } = desktop(3, { kittyFails: true });
		const watched = parkingOn(desk);
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(readParked(SESSION, folder)?.windows).toEqual({
			closed: [],
			open: "kitty didn't close window 33",
		});
	});

	it("keeps nothing of windows in its marker off niri", () => {
		const { desk } = desktop(3);
		const watched = parkingOn(desk, holder());
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(readParked(SESSION, folder)).toBeDefined();
		expect(readParked(SESSION, folder)?.windows).toBeUndefined();
	});

	it("asks the desktop nothing off niri, parking as before", () => {
		const { calls, desk } = desktop(1, { focused: true });
		const watched = parkingOn(desk, holder());
		clock = NAMED_PARK_AFTER_MS;
		expect(watched.look()).toBeUndefined();
		expect(calls).toEqual([]);
		expect(exits).toEqual([PARKED_EXIT]);
	});

	it("asks the desktop nothing while something else keeps it awake", () => {
		const { calls, desk } = desktop(3);
		const watched = parkingOn(desk);
		clock = NAMED_PARK_AFTER_MS - 1;
		expect(watched.look()).toBe("not idle long enough");
		expect(calls).toEqual([]);
	});

	it("leaves a hosted conversation's window to its host", () => {
		const { calls, desk } = desktop(3);
		const host = installTestHost();
		host.host.park = () => {};
		try {
			const watched = parkingOn(desk);
			clock = NAMED_PARK_AFTER_MS;
			expect(watched.look()).toBeUndefined();
			expect(calls).toEqual([]);
		} finally {
			host.dispose();
		}
	});
});

describe("starting again on a fresh log", () => {
	const fresh = () => join(folder, "fresh.jsonl");
	const asked = (byHand = false): RestartAsk => {
		const ask: RestartAsk = {
			session: SESSION,
			sessionFile: fresh(),
			...(byHand ? { asked: true } : {}),
		};
		events.emit(RESTART_ASK, ask);
		return ask;
	};
	let restarts: string[];
	let fallbacks: (() => void)[];
	let focused: string | null;
	let said: string[];
	const restarting = (env: NodeJS.ProcessEnv = holder(), args: string[] = []) =>
		watch(session(), events, {
			env,
			args,
			pid: HELD_PID,
			switchPath: parkSwitch(folder),
			folder,
			now: () => clock,
			exitWith: (code) => exits.push(code),
			restartWith: (sessionFile, fallback) => {
				restarts.push(sessionFile);
				fallbacks.push(fallback);
			},
			setExitCode: (code) => exits.push(code),
			say: (line) => said.push(line),
			focusedWindow: () => focused,
			clock: false,
		});
	/** The holder's record, showing the session in windows of these app ids. */
	const shownIn = (...appIds: string[]) =>
		writeFileSync(
			join(folder, "held.json"),
			JSON.stringify({
				pid: HELD_PID,
				windows: appIds.map((app_id, at) => ({
					terminal: "kitty",
					id: String(at + 1),
					within: "unix:@kitty-2684",
					app_id,
				})),
			}),
		);

	beforeEach(() => {
		restarts = [];
		fallbacks = [];
		said = [];
		focused = "pi-session.3";
		writeFileSync(fresh(), "");
	});

	// 10 November, krc-5: started again through its holder, the window
	// said "Parked, its memory given back" while it came back, which it
	// never was. In place, the holder sees no exit at all.
	it("ends at once, not idle, to start again in place on the fresh log, waking its holder for nothing", () => {
		restarting();
		const ask = asked();
		expect(ask).toMatchObject({ restarting: true });
		expect(ask.why).toBeUndefined();
		expect(restarts).toEqual([fresh()]);
		expect(
			JSON.parse(readFileSync(join(folder, "held.again"), "utf8")),
			"named before pi ends, so whatever starts it next opens the fresh log",
		).toEqual(["pi", "--session", fresh()]);
		expect(readdirSync(folder)).not.toContain("held.wake");
		expect(exits).toEqual([]);
		expect(shutdowns).toBe(1);
		// Back in a moment, it is never marked parked.
		expect(readParked(SESSION, folder)).toBeUndefined();
		expect(asked().why).toBe("parking already");
		expect(shutdowns).toBe(1);
	});

	it("has its holder start it again on the fresh log when it can't be replaced in place", () => {
		restarting();
		asked();
		fallbacks[0]?.();
		expect(
			JSON.parse(readFileSync(join(folder, "held.again"), "utf8")),
		).toEqual(["pi", "--session", fresh()]);
		expect(
			JSON.parse(readFileSync(join(folder, "held.wake"), "utf8")),
		).toMatchObject({ session: SESSION, restart: fresh() });
		expect(exits).toEqual([PARKED_EXIT]);
	});

	// A shutdown that hangs before the exit, where the restart runs, ends
	// by a signal: said only there, the holder would let the window go.
	it("tells its holder the run parked as it commits to starting again, before pi ends", () => {
		const parked = join(folder, "held.parked");
		restarting({ ...holder(), MYCELIUM_PARKED: parked });
		asked();
		expect(shutdowns, "pi is asked to end").toBe(1);
		expect(readFileSync(parked, "utf8"), "said before it exits").toBe("");
		fallbacks[0]?.();
		expect(readFileSync(parked, "utf8"), "ending for its holder").toBe("");
		expect(exits).toEqual([PARKED_EXIT]);
	});

	// Node ends a process whose execve call fails by abort, with no
	// fallback (PV3TE0 on node 24, 21 November): taken back before it,
	// the window would be lost, unparked and unwoken.
	it("leaves the park said through the execve, for the pi it becomes to take back as it starts", () => {
		const parked = join(folder, "held.parked");
		const env = {
			...holder(),
			MYCELIUM_PARKED: parked,
			PI_SESSION_FILE: "/logs/first.jsonl",
		};
		shownIn("kitty");
		restarting(env);
		asked();
		expect(readFileSync(parked, "utf8"), "standing as it is replaced").toBe("");

		const becomes = restartEnvironment(env, HELD_PID);
		expect(becomes[PARK_SAID_ENV], "the pi it becomes knows who said it").toBe(
			String(HELD_PID),
		);
		expect(becomes.PI_SESSION_FILE, "a first start's alone").toBe(undefined);
		takeBackRestartPark(becomes, HELD_PID);

		expect(existsSync(parked), "up again, it hasn't parked").toBe(false);
	});

	// One-writer's hand-over says a park in the same session_start
	// (F14, #1951), and pi may run its handler first: only the factory,
	// as pi loads it, takes a restart's park back (index.test.ts).
	it("takes back no park as it starts watching, even one a restart said", () => {
		const parked = join(folder, "held.parked");
		writeFileSync(parked, "");

		restarting({
			...holder(),
			MYCELIUM_PARKED: parked,
			[PARK_SAID_ENV]: String(HELD_PID),
		});

		expect(readFileSync(parked, "utf8"), "another's park stands").toBe("");
	});

	it("says nothing of a park when it refuses to start again", () => {
		const parked = join(folder, "held.parked");
		restarting({ ...holder(), MYCELIUM_AGAIN: "", MYCELIUM_PARKED: parked });
		expect(asked().why).toBe("its holder would start it on the log it left");
		expect(existsSync(parked)).toBe(false);
	});

	it("keeps the command for the fresh log, saying why, when its holder's wake can't be written", () => {
		mkdirSync(join(folder, "held.wake"));
		restarting();
		asked();
		fallbacks[0]?.();
		expect(
			JSON.parse(readFileSync(join(folder, "held.again"), "utf8")),
			"a key starts it on the fresh log, not on what its holder first ran",
		).toEqual(["pi", "--session", fresh()]);
		expect(said).toEqual([
			expect.stringMatching(
				/^It stays parked until a key starts it again, since its holder couldn't be woken: EISDIR.*held\.wake/,
			),
		]);
		expect(exits).toEqual([PARKED_EXIT]);
	});

	// Round 3, 20 November: named only once pi had ended, a command that
	// couldn't be written left the window parked on the log it left, or
	// on a bare pi, while it said it would start again.
	it("stays, saying why and naming the file, when its command can't be written", () => {
		mkdirSync(join(folder, "held.again"));
		restarting();
		const ask = asked();
		expect(ask.why, "it says why").toMatch(
			/^its holder couldn't be told how to start it again: EISDIR/,
		);
		expect(ask.why, "it names the command's own file").toContain(
			join(folder, "held.again"),
		);
		expect(ask.restarting, "the rollover is told it stays").toBeUndefined();
		expect(restarts).toEqual([]);
		expect(shutdowns).toBe(0);
		expect(
			readdirSync(join(folder, WRITING)),
			"the failed write leaves nothing staged",
		).toEqual([]);
		expect(readdirSync(folder)).not.toContain("held.wake");
		expect(exits).toEqual([]);
	});

	// A rename's error names its target by itself, so only a write that
	// fails before it, here at staging, shows whether the why names the
	// command's own file rather than the staged one or none.
	it("names the command's own file when its write fails before naming it", () => {
		writeFileSync(join(folder, WRITING), "");
		restarting();
		const ask = asked();
		expect(
			ask.why,
			"the error names only the staging folder, so the why adds the file",
		).toMatch(/^its holder couldn't be told how to start it again: E/);
		expect(
			ask.why?.endsWith(`, to ${join(folder, "held.again")}`),
			`it ends naming the command's own file: ${ask.why}`,
		).toBe(true);
		expect(restarts).toEqual([]);
		expect(exits).toEqual([]);
	});

	it("leaves the command named before when its own is cut short, and stays", () => {
		const again = join(folder, "held.again");
		writeFileSync(again, JSON.stringify(["pi", "--session", "before.jsonl"]));
		writeFileSync(
			join(folder, WRITING),
			"a file where its staging folder goes",
		);
		restarting();
		const ask = asked();
		expect(
			JSON.parse(readFileSync(again, "utf8")),
			"a write that fails empties nothing",
		).toEqual(["pi", "--session", "before.jsonl"]);
		expect(ask.why).toMatch(
			/^its holder couldn't be told how to start it again: E(EXIST|NOTDIR).*held\.again/,
		);
		expect(shutdowns).toBe(0);
	});

	it("has its holder start it fenced on the fresh log, as it was started", () => {
		restarting({ ...holder(), PI_SANDBOX: "fence" });
		asked();
		fallbacks[0]?.();
		expect(
			JSON.parse(readFileSync(join(folder, "held.again"), "utf8")),
		).toEqual(["env", "PI_SANDBOX=fence", "pi", "--session", fresh()]);
	});

	// WCJQSG, 10 November [e7c3cbbf]: never in the window Joel has
	// focused, or one he was in within the last ten minutes.
	it("stays in the window its person has focused, or can't be told isn't", () => {
		shownIn("pi-session.3");
		const watched = restarting();
		expect(asked()).toMatchObject({
			why: "its window may be the one focused",
		});
		focused = null;
		expect(asked()).toMatchObject({
			why: "the desktop can't say which window is focused",
		});
		shownIn("");
		focused = "pi-session.9";
		expect(asked()).toMatchObject({
			why: "its window may be the one focused",
		});
		expect(restarts).toEqual([]);
		watched.stop();
		shownIn("pi-session.3", "pi-session.4");
		restarting();
		focused = "pi-session.9";
		expect(asked()).toMatchObject({ restarting: true });
		expect(restarts).toEqual([fresh()]);
	});

	it("stays for ten minutes after its person was last at its window", () => {
		const watched = restarting();
		clock = 1_000;
		watched.present();
		clock += UNWATCHED_MS - 1;
		expect(asked()).toMatchObject({
			why: "its person was at its window in the last ten minutes",
		});
		clock += 1;
		expect(asked()).toMatchObject({ restarting: true });
	});

	// WCJQSG, 11 November [0de9accb]: an orchestrator Joel is always at
	// never found a moment nobody watched, so it never took an install.
	it("starts again while its person watches, when they asked for it", () => {
		shownIn("pi-session.3");
		const watched = restarting();
		watched.present();
		expect(asked(), "a restart nobody asked for waits").toMatchObject({
			why: "its person was at its window in the last ten minutes",
		});
		expect(asked(true), "the one they asked for goes").toMatchObject({
			restarting: true,
		});
		expect(restarts, "it starts again on the log it was given").toEqual([
			fresh(),
		]);
	});

	it("asks the others as a restart, not a park", () => {
		restarting();
		const heard: unknown[] = [];
		const unhear = events.on(PARK_ASK, (data) => heard.push(data));
		asked();
		unhear();
		expect(heard, "the ask says it is for a restart").toEqual([
			{ session: SESSION, refusals: [], restart: true },
		]);
	});

	it("stays for a background job, typed text or what another extension holds", () => {
		const watched = restarting();
		const stop = announceJobHost(events, {
			start: () => {
				throw new Error("not started here");
			},
			pending: () => 1,
		});
		expect(asked()).toMatchObject({ why: "background jobs are out" });
		stop();
		typed = "half a thought";
		expect(asked()).toMatchObject({ why: "text is typed and unsent" });
		typed = "";
		const unrefuse = events.on(PARK_ASK, (data) => {
			if (isParkAsk(data)) data.refusals.push("peers wait on a hold it sent");
		});
		expect(asked()).toMatchObject({ why: "peers wait on a hold it sent" });
		unrefuse();
		expect(shutdowns).toBe(0);
		expect(readdirSync(folder)).not.toContain("held.wake");
		watched.stop();
		expect(asked()).not.toHaveProperty("why");
	});

	it("stays while parking is off, or where its holder would start the log it left", () => {
		rmSync(parkSwitch(folder));
		const off = restarting();
		expect(asked()).toMatchObject({ why: "parking is off" });
		off.stop();
		writeFileSync(parkSwitch(folder), "on\n");
		const { MYCELIUM_WAKE } = holder();
		const bare = restarting({ MYCELIUM_WAKE });
		expect(asked()).toMatchObject({
			why: "its holder would start it on the log it left",
		});
		bare.stop();
		restarting(holder(), ["-e", "./x.ts"]);
		expect(asked()).toMatchObject({ why: "starting again would drop -e" });
		expect(shutdowns).toBe(0);
	});

	it("answers only for its own session", () => {
		restarting();
		const other: RestartAsk = { session: "another", sessionFile: fresh() };
		events.emit(RESTART_ASK, other);
		expect(other).not.toHaveProperty("restarting");
		expect(shutdowns).toBe(0);
	});
});

describe("replacing the process in place", () => {
	const argv = ["/bin/node", "pi.js", "--session", "s.jsonl"] as const;

	const recording =
		(steps: string[]): NodeJS.Process["execve"] =>
		(file, args, env) => {
			steps.push(`execve ${file} ${args?.join(" ")} ${env?.HOME}`);
			return undefined as never;
		};

	it("replaces it by execve when its program can run", () => {
		const steps: string[] = [];
		replaceInPlace(recording(steps), argv, { HOME: "/home/joel" }, () => true);
		expect(steps).toEqual([
			"execve /bin/node /bin/node pi.js --session s.jsonl /home/joel",
		]);
	});

	// Node aborts on a failed execve call rather than throwing, so a
	// program gone from under a long-running pi has to be caught first.
	it("returns without calling execve when its program can't be run, so its holder starts it", () => {
		const steps: string[] = [];
		replaceInPlace(recording(steps), argv, {}, () => false);
		expect(steps).toEqual([]);
	});

	it("returns without calling execve where its program is gone from the disk", () => {
		const steps: string[] = [];
		replaceInPlace(
			recording(steps),
			[join(folder, "no-such-node"), "pi.js"],
			{},
		);
		expect(steps).toEqual([]);
	});

	it("returns where Node has no execve, so its holder starts it", () => {
		expect(() => replaceInPlace(undefined, argv, {}, () => true)).not.toThrow();
	});

	it("returns, never throwing, when execve throws", () => {
		expect(() =>
			replaceInPlace(
				() => {
					throw new Error("ENOENT: no such file, execve");
				},
				argv,
				{},
				() => true,
			),
		).not.toThrow();
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
		expect(flagsLost(["-e", "x.ts", "--model=m"])).toEqual(["-e"]);
		expect(
			flagsLost(["--model", "m", "--provider", "p", "--thinking", "high"]),
			"the model flags are carried, with their values",
		).toEqual([]);
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

describe("why a session stays awake", () => {
	// 9 November: 32 of 73 sessions sat idle and awake overnight, and
	// nothing kept why (KP0L6A [1631f567]).
	const awake = () => {
		try {
			return JSON.parse(readFileSync(awakePath(SESSION, folder), "utf8"));
		} catch {
			return undefined;
		}
	};

	it("is kept as it changes, since when, and cleared once it parks", () => {
		const watched = watching();
		clock = 1000;
		watched.look();
		const first = awake();
		clock = 2000;
		watched.look();

		expect(first).toEqual({
			session: SESSION,
			why: "not idle long enough",
			since: new Date(1000).toISOString(),
		});
		expect(awake(), "a reason unchanged is not written again").toEqual(first);

		typed = "half a thought";
		clock = NAMED_PARK_AFTER_MS;
		watched.look();
		expect(awake()?.why).toBe("text is typed and unsent");

		typed = "";
		watched.look();
		expect(
			awake(),
			"a session that parked keeps nothing awake",
		).toBeUndefined();
	});

	it("is cleared as the session ends", () => {
		const watched = watching();
		watched.look();
		watched.stop();

		expect(awake()).toBeUndefined();
	});

	it("refuses in a host, even with a screen and a holder, naming the host", () => {
		const watched = watching();
		const host = installTestHost();
		try {
			clock = NAMED_PARK_AFTER_MS;
			expect(mayPark(session(), holder()), "a hosted session").toBe(false);
			expect(watched.look()).toBe(HOST_PARKS);
			expect(
				{ shutdowns, exits, parked: readParked(SESSION, folder) },
				"a hosted session never ends its process",
			).toEqual({ shutdowns: 0, exits: [], parked: undefined });
			expect(watched.endedItsProcess(), "a host's process is left to it").toBe(
				false,
			);
			expect(awake()?.why).toBe(HOST_PARKS);

			expect(
				noteNeverParks(session(), holder(), folder),
				"a hosted session says why it never parks, holder or not",
			).toBe(true);
			expect(awake()?.why).toBe(HOST_PARKS);
		} finally {
			host.dispose();
		}
	});

	// 11 November: a hosted conversation stayed loaded while plain pi's
	// park let its process go, 116 MB of its host idle (OSPHT4 [a5ee3986]).
	it("parks by the same rule in a host that parks one conversation, leaving the rest to it", () => {
		const host = installTestHost();
		const asked: string[] = [];
		host.host.park = (id) => asked.push(id);
		const said: (string | undefined)[] = [];
		events.on(PARKING, (data) => {
			if (isParking(data)) said.push(data.wake);
		});
		// What the engine gives each conversation: a wake, and no restart command.
		const conversation = { MYCELIUM_WAKE: join(folder, "conversation.wake") };
		try {
			expect(mayPark(session(), conversation), "a host that parks").toBe(true);
			expect(
				noteNeverParks(session(), conversation, folder),
				"a conversation its host parks says nothing of never parking",
			).toBe(false);
			const watched = watching(session(), conversation);
			clock = NAMED_PARK_AFTER_MS - 1;
			expect(watched.look()).toBe("not idle long enough");
			clock = NAMED_PARK_AFTER_MS;
			expect(watched.look(), "parked by plain pi's rule").toBeUndefined();

			expect(asked, "the host was asked to park it").toEqual([SESSION]);
			expect(
				{ shutdowns, exits },
				"the host's process, every conversation's, carries on",
			).toEqual({ shutdowns: 0, exits: [] });
			expect(said, "the mesh is told where to wake it").toEqual([
				conversation.MYCELIUM_WAKE,
			]);
			expect(
				readParked(SESSION, folder)?.wake,
				"its marker names its wake, as plain pi's does",
			).toBe(conversation.MYCELIUM_WAKE);
			expect(watched.look(), "it parks once").toBe("parking already");
		} finally {
			host.dispose();
		}
	});

	// 16 November: the background host's 17 conversations took turns that
	// overlapped for over an hour, so its restart found no moment with none
	// running (16V6F4 [654e24da]).
	it("parks a hosted conversation as soon as its rule holds while its host drains, and waits its time again once the drain lifts", () => {
		const host = installTestHost();
		const asked: string[] = [];
		let draining = true;
		host.host.park = (id) => asked.push(id);
		host.host.draining = () => draining;
		const conversation = { MYCELIUM_WAKE: join(folder, "conversation.wake") };
		try {
			const busy = watching(session({ isIdle: () => false }), conversation);
			expect(busy.look(), "a running one stays, drain or not").not.toBe(
				undefined,
			);
			busy.stop();

			draining = false;
			const usual = watching(session(), conversation);
			expect(usual.look(), "undrained, it waits its time").toBe(
				"not idle long enough",
			);
			draining = true;
			expect(usual.look(), "drained, it parks at once").toBeUndefined();
			expect(asked).toEqual([SESSION]);
		} finally {
			host.dispose();
		}
	});

	// 22 November: 15 children ran host code 34 hours old, holding 10.9 GB,
	// since a child never restarts (3PXQTB [bc2e766b]); one whose host code
	// is stale parks at its next quiet moment, so its wake starts it fresh.
	it("parks a hosted conversation as soon as its rule holds once its host rolls onto new code", () => {
		const host = installTestHost();
		const asked: string[] = [];
		let rolling = false;
		host.host.park = (id) => asked.push(id);
		// Only this conversation rolls, as a host whose window views another says.
		host.host.rolling = (id) => rolling && id === SESSION;
		const conversation = { MYCELIUM_WAKE: join(folder, "conversation.wake") };
		try {
			const busy = watching(session({ isIdle: () => false }), conversation);
			rolling = true;
			expect(busy.look(), "a running one stays, stale or not").not.toBe(
				undefined,
			);
			busy.stop();

			rolling = false;
			const usual = watching(session(), conversation);
			expect(usual.look(), "current, it waits its time").toBe(
				"not idle long enough",
			);
			rolling = true;
			expect(usual.look(), "stale, it parks at once").toBeUndefined();
			expect(asked).toEqual([SESSION]);
		} finally {
			host.dispose();
		}
	});

	// 21 November: 75 background conversations, each its own process since
	// the day before, held about 20 GB, and 37 had sent nothing for five
	// minutes while the half hour kept them (A2VLJN [ebe376a1]).
	it("parks a background host's conversation after five idle minutes, or sooner where its own limit is, while an attended host's waits its half hour", () => {
		const conversation = { MYCELIUM_WAKE: join(folder, "conversation.wake") };
		const parksAfter = (
			key: string,
			line = "on",
			viewed = false,
			platform: NodeJS.Platform = "linux",
		): number | undefined => {
			writeFileSync(parkSwitch(folder), `${line}\n`);
			// Each starts unparked, not woken from the one before's marker.
			rmSync(join(folder, "parked"), { recursive: true, force: true });
			const host = installTestHost(key);
			const asked: string[] = [];
			host.host.park = (id) => asked.push(id);
			host.host.viewed = () => viewed;
			try {
				clock = 0;
				const watched = watching(session(), conversation, [], platform);
				for (const at of [
					NAMED_PARK_AFTER_MS - 1,
					NAMED_PARK_AFTER_MS,
					BACKGROUND_PARK_AFTER_MS - 1,
					BACKGROUND_PARK_AFTER_MS,
					PARK_AFTER_MS - 1,
					PARK_AFTER_MS,
				]) {
					clock = at;
					if (watched.look() === undefined && asked.length > 0) {
						expect(
							readParked(SESSION, folder)?.afterMs,
							"its marker names the limit it parked under",
						).toBe(at);
						return at;
					}
				}
				return undefined;
			} finally {
				host.dispose();
			}
		};
		expect(parksAfter("one-background"), "background parks at five").toBe(
			BACKGROUND_PARK_AFTER_MS,
		);
		expect(parksAfter("one-attended"), "attended waits its half hour").toBe(
			PARK_AFTER_MS,
		);
		expect(
			parksAfter("one-background", "on", true),
			"background with a window on it waits its half hour",
		).toBe(PARK_AFTER_MS);
		expect(
			parksAfter("one-background", SESSION),
			"named in the switch, background parks at its two minutes",
		).toBe(NAMED_PARK_AFTER_MS);
		// 21 November: four Mac holders were lost as their sessions parked
		// (WCJQSG [1cf71a07]), so a Mac keeps its half hour.
		expect(
			parksAfter("one-background", "on", false, "darwin"),
			"background on macOS waits its half hour",
		).toBe(PARK_AFTER_MS);
	});

	/**
	 * The node asks this session to ease at `at` on the test's clock, so
	 * the ask and the watch share one timeline (#1976 F46).
	 */
	const askToEase = (at = 0) => {
		mkdirSync(join(folder, "ease"), { recursive: true });
		writeFileSync(easePath(SESSION, folder), '{"at":"now","why":"memory"}\n');
		utimesSync(easePath(SESSION, folder), at / 1000, at / 1000);
	};

	// 22 November: the node asks idle sessions to park soon while its
	// machine reads over, through a file of their own rather than the
	// switch every session shares (KP0L6A [1b7b2cd5]).
	it("parks a background conversation asked to ease after two minutes unless the switch says off, taking the ask back as it parks", () => {
		const conversation = { MYCELIUM_WAKE: join(folder, "conversation.wake") };
		const eased = () => existsSync(easePath(SESSION, folder));
		const parksAfter = (
			line: string,
			{
				viewed = false,
				platform = "linux",
				env = conversation,
			}: {
				viewed?: boolean;
				platform?: NodeJS.Platform;
				env?: NodeJS.ProcessEnv;
			} = {},
		): number | undefined => {
			writeFileSync(parkSwitch(folder), `${line}\n`);
			rmSync(join(folder, "parked"), { recursive: true, force: true });
			askToEase();
			const host = installTestHost("one-background");
			const asked: string[] = [];
			host.host.park = (id) => asked.push(id);
			host.host.viewed = () => viewed;
			try {
				clock = 0;
				const watched = watching(session(), env, [], platform);
				for (const at of [
					EASED_PARK_AFTER_MS - 1,
					EASED_PARK_AFTER_MS,
					BACKGROUND_PARK_AFTER_MS - 1,
					BACKGROUND_PARK_AFTER_MS,
					PARK_AFTER_MS - 1,
					PARK_AFTER_MS,
				]) {
					clock = at;
					if (watched.look() === undefined && asked.length > 0) {
						expect(eased(), "its ask is taken back as it parks").toBe(false);
						expect(
							readParked(SESSION, folder)?.afterMs,
							"its marker names the limit it parked under",
						).toBe(at);
						return at;
					}
				}
				expect(eased(), "awake, its ask stays").toBe(true);
				return undefined;
			} finally {
				host.dispose();
			}
		};
		expect(parksAfter("on"), "switch on").toBe(EASED_PARK_AFTER_MS);
		expect(parksAfter(""), "switch empty").toBe(EASED_PARK_AFTER_MS);
		expect(parksAfter("off"), "the switch says off").toBeUndefined();
		expect(
			parksAfter("on\noff"),
			"off beats the ask, not the switch's own rule",
		).toBe(BACKGROUND_PARK_AFTER_MS);
		expect(
			parksAfter("on", { viewed: true }),
			"a window on it keeps its half hour",
		).toBe(PARK_AFTER_MS);
		expect(
			parksAfter("", { viewed: true }),
			"a window on it, switch empty, stays",
		).toBeUndefined();
		expect(
			parksAfter("on", { platform: "darwin" }),
			"macOS keeps its half hour",
		).toBe(PARK_AFTER_MS);
		expect(
			parksAfter("on", { env: { ...conversation, PI_PARK: "off" } }),
			"PI_PARK=off still wins",
		).toBeUndefined();
	});

	it("keeps an eased conversation awake while it holds anything", () => {
		const host = installTestHost("one-background");
		const asked: string[] = [];
		host.host.park = (id) => asked.push(id);
		let idle = true;
		let jobs = 0;
		const stop = announceJobHost(events, {
			start: () => {
				throw new Error("not started here");
			},
			pending: () => jobs,
		});
		try {
			writeFileSync(parkSwitch(folder), "\n");
			askToEase();
			clock = 0;
			const watched = watching(session({ isIdle: () => idle }), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
			});
			clock = EASED_PARK_AFTER_MS;
			jobs = 1;
			expect(watched.look()).toBe("background jobs are out");
			jobs = 0;
			typed = "half a thought";
			expect(watched.look()).toBe("text is typed and unsent");
			typed = "";
			idle = false;
			expect(watched.look()).toBe(RUN_UNDER_WAY);
			idle = true;
			watched.prompting(true);
			clock += EASED_PARK_AFTER_MS;
			expect(watched.look()).toBe("a prompt is open");
			expect(asked, "nothing parked").toEqual([]);
			expect(existsSync(easePath(SESSION, folder)), "its ask stays").toBe(true);
		} finally {
			stop();
			host.dispose();
		}
	});

	it("honours no ask dated ahead of its clock, as a clock stepped back leaves one", () => {
		const host = installTestHost("one-background");
		const asked: string[] = [];
		host.host.park = (id) => asked.push(id);
		try {
			writeFileSync(parkSwitch(folder), "\n");
			askToEase(EASE_LASTS_MS);
			clock = 0;
			const watched = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
			});
			clock = EASED_PARK_AFTER_MS;
			expect(watched.look(), "an ask from its future parks nobody").toBe(
				"parking is off",
			);
			expect(asked).toEqual([]);
		} finally {
			host.dispose();
		}
	});

	it("lets an ask nobody wrote again in half an hour lapse, handing it back to the switch's rule", () => {
		const host = installTestHost("one-background");
		const asked: string[] = [];
		host.host.park = (id) => asked.push(id);
		try {
			writeFileSync(parkSwitch(folder), "on\n");
			askToEase(0);
			const started = EASE_LASTS_MS - EASED_PARK_AFTER_MS;
			clock = started;
			const watched = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
			});
			clock = EASE_LASTS_MS + 1;
			expect(watched.look(), "a lapsed ask parks nobody early").toBe(
				"not idle long enough",
			);
			expect(asked).toEqual([]);
			clock = started + BACKGROUND_PARK_AFTER_MS;
			expect(watched.look(), "the switch's own rule parks it").toBe(undefined);
			expect(asked).toEqual([SESSION]);
			expect(readParked(SESSION, folder)?.afterMs).toBe(
				BACKGROUND_PARK_AFTER_MS,
			);
		} finally {
			host.dispose();
		}
	});

	it("never eases a plain pi, whose window its person may have open", () => {
		// Dated on the fake clock, or the skew bound alone would refuse it
		// and this would pin no scope (#1976 F74).
		askToEase();
		writeFileSync(parkSwitch(folder), "\n");
		const watched = watching();
		// Two minutes in: well inside the ask's half hour, and past its limit.
		clock = EASED_PARK_AFTER_MS;
		expect(watched.look()).toBe("parking is off");
	});

	it("takes back an ask to ease as it wakes, keeping it through a stop or a reload", () => {
		const ease = () => {
			mkdirSync(join(folder, "ease"), { recursive: true });
			writeFileSync(easePath(SESSION, folder), "{}\n");
		};
		const eased = () => existsSync(easePath(SESSION, folder));
		ease();
		const started = watching();
		expect(eased(), "a plain start keeps it").toBe(true);
		started.stop();
		expect(
			eased(),
			"a reload, or a host's stop that resumes it, keeps it",
		).toBe(true);
		writeParked(
			{
				session: SESSION,
				sessionFile: logOf(),
				cwd: "/src",
				addresses: [],
				parkedAt: new Date(0).toISOString(),
				pid: HELD_PID,
				wake: join(folder, "held.wake"),
			},
			folder,
		);
		watching().stop();
		expect(eased(), "a wake takes it back").toBe(false);
	});

	it("keeps a background host's conversation awake when PI_PARK is off for it or the switch is off, and parks it at once in a drain", () => {
		const host = installTestHost("one-background");
		const asked: string[] = [];
		let draining = false;
		host.host.park = (id) => asked.push(id);
		host.host.draining = () => draining;
		try {
			writeFileSync(parkSwitch(folder), "\n");
			clock = 0;
			const switchedOff = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
			});
			clock = PARK_AFTER_MS;
			expect(switchedOff.look(), "no switch, no park").toBe("parking is off");
			expect(asked, "nothing asked with the switch off").toEqual([]);
			switchedOff.stop();
			writeFileSync(parkSwitch(folder), "on\n");
			clock = 0;
			const off = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
				PI_PARK: "off",
			});
			clock = PARK_AFTER_MS;
			expect(off.look()).toBe("parking is off");
			expect(asked).toEqual([]);
			off.stop();
			clock = 0;
			const drained = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
			});
			expect(drained.look(), "undrained, it waits").toBe(
				"not idle long enough",
			);
			draining = true;
			expect(drained.look(), "drained, it parks at once").toBeUndefined();
			expect(asked).toEqual([SESSION]);
			expect(
				readParked(SESSION, folder)?.afterMs,
				"a drain's park says so, and its wake isn't the rule's",
			).toBe(0);
			drained.stop();
			writeFileSync(parkSwitch(folder), "\n");
			clock = 0;
			const drainedSwitchedOff = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
			});
			expect(
				drainedSwitchedOff.look(),
				"a drain parks it with the switch off too",
			).toBeUndefined();
			expect(asked).toEqual([SESSION, SESSION]);
			drainedSwitchedOff.stop();
			writeFileSync(parkSwitch(folder), "off\n");
			clock = 0;
			const drainedLineOff = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
			});
			expect(
				drainedLineOff.look(),
				"a drain parks it under a line off too",
			).toBeUndefined();
			expect(asked).toEqual([SESSION, SESSION, SESSION]);
		} finally {
			host.dispose();
		}
	});

	// 22 November, 05:52: 26 of 78 background conversations, 8.8 GB, stayed
	// awake only for a bash call, most a loop waiting on another run's rc.
	it("parks a background host's conversation with only bash calls out where its host carries them, and stays for anything else", () => {
		const host = installTestHost("one-background");
		const asked: string[] = [];
		let carries = true;
		let viewed = false;
		host.host.park = (id) => asked.push(id);
		host.host.carries = () => carries;
		host.host.viewed = () => viewed;
		// As job-workflow's own: a job whose spec can't carry it (a shell
		// whose tee won't outlive pi) holds, whatever the host keeps.
		const shell = (over: Record<string, unknown> = {}) => ({
			kind: "shell",
			keep: join(folder, "kept"),
			pid: 2 ** 22 + 1,
			mark: "a-mark",
			startedAt: 0,
			...over,
		});
		const out: {
			id: string;
			kind: string;
			label: string;
			carry?: { kind: string; [field: string]: unknown };
		}[] = [
			{
				id: "j1",
				kind: "shell",
				label: "until grep -q rc= run.log",
				carry: shell(),
			},
		];
		let unsaid = 0;
		const stopJobs = announceJobHost(events, {
			start: () => {
				throw new Error("not started here");
			},
			pending: () => out.length + unsaid,
			running: () => out,
			holds: (carriable = () => true) =>
				out.filter((job) => job.carry === undefined || !carriable(job.carry)),
		});
		const env = { MYCELIUM_WAKE: join(folder, "conversation.wake") };
		try {
			writeFileSync(parkSwitch(folder), "on\n");
			clock = 0;
			const onMac = watching(session(), env, [], "darwin");
			const watched = watching(session(), env, [], "linux");
			clock = BACKGROUND_PARK_AFTER_MS;

			carries = false;
			expect(watched.look(), "a host that can't keep it").toBe(
				"a command is out (j1: until grep -q rc= run.log)",
			);
			carries = true;
			viewed = true;
			clock = PARK_AFTER_MS;
			expect(watched.look(), "a window views it").toBe(
				"a command is out (j1: until grep -q rc= run.log)",
			);
			viewed = false;
			expect(onMac.look(), "a Mac's holder is lost in a park").toBe(
				"a command is out (j1: until grep -q rc= run.log)",
			);
			onMac.stop();
			out.push({ id: "j2", kind: "subagent", label: "k7-read" });
			expect(watched.look(), "a fleet goes nowhere").toBe(
				"a fleet is out (j2: k7-read)",
			);
			out.pop();
			// One its watch would wake for at once holds it, rather than a park
			// and a wake every few minutes (#1981 F72).
			out.push({
				id: "j4",
				kind: "shell",
				label: "sleep 1d",
				carry: shell({ startedAt: PARK_AFTER_MS - CALLS_WATCHED_MS }),
			});
			expect(watched.look(), "a call a day old").toBe(
				"a command is out (j4: sleep 1d)",
			);
			out.pop();
			// A drain lists heavy runs only from awake conversations, so a
			// suite or a build a park carried would be cut by a drained
			// restart (#1981 F70).
			out.push({
				id: "j6",
				kind: "shell",
				label: "pnpm test",
				carry: shell(),
			});
			expect(watched.look(), "a heavy run").toBe(
				"a command is out (j6: pnpm test)",
			);
			out.pop();
			out.push({
				id: "j5",
				kind: "shell",
				label: "timeout 60",
				carry: shell({ deadline: PARK_AFTER_MS }),
			});
			expect(watched.look(), "a call past its limit").toBe(
				"a command is out (j5: timeout 60)",
			);
			out.pop();
			out.push({ id: "j3", kind: "shell", label: "tee run.log" });
			expect(watched.look(), "a call that can't outlive pi").toBe(
				"a command is out (j3: tee run.log)",
			);
			unsaid = 1;
			expect(
				watched.look(),
				"a held call beside an end not yet said names neither",
			).toBe("background jobs are out");
			out.pop();
			expect(watched.look(), "an end not yet said").toBe(
				"background jobs are out",
			);
			unsaid = 0;
			expect(asked, "nothing parked yet").toEqual([]);

			expect(watched.look(), "only a carried call: it parks").toBeUndefined();
			expect(asked).toEqual([SESSION]);
		} finally {
			stopJobs();
			host.dispose();
		}
	});

	it("stays for every job a job host from before its holds says is out", () => {
		const host = installTestHost("one-background");
		const asked: string[] = [];
		host.host.park = (id) => asked.push(id);
		host.host.carries = () => true;
		const stopJobs = announceJobHost(events, {
			start: () => {
				throw new Error("not started here");
			},
			pending: () => 1,
		});
		try {
			writeFileSync(parkSwitch(folder), "on\n");
			clock = 0;
			const watched = watching(
				session(),
				{ MYCELIUM_WAKE: join(folder, "conversation.wake") },
				[],
				"linux",
			);
			clock = PARK_AFTER_MS;
			expect(watched.look()).toBe("background jobs are out");
			expect(asked).toEqual([]);
		} finally {
			stopJobs();
			host.dispose();
		}
	});

	it("notes each wake with how long it rested, keeping a day of them", () => {
		const park = (parkedAt: number) =>
			writeParked(
				{
					session: SESSION,
					sessionFile: logOf(),
					cwd: "/src",
					addresses: [],
					parkedAt: new Date(parkedAt).toISOString(),
					pid: HELD_PID,
					wake: join(folder, "held.wake"),
				},
				folder,
			);
		park(1_000);
		clock = 61_000;
		watching().stop();
		expect(readWakes(SESSION, folder)).toEqual([
			{
				parkedAt: new Date(1_000).toISOString(),
				wokeAt: new Date(61_000).toISOString(),
				restedMs: 60_000,
			},
		]);
		watching().stop();
		expect(
			readWakes(SESSION, folder),
			"a start with no marker is no wake",
		).toHaveLength(1);
		park(100_000);
		clock = 130_000;
		watching().stop();
		expect(
			readWakes(SESSION, folder).map((wake) => wake.restedMs),
			"a second wake joins the first",
		).toEqual([60_000, 30_000]);
		const later = 61_000 + WAKES_KEPT_MS;
		park(later - 5_000);
		clock = later;
		watching().stop();
		expect(
			readWakes(SESSION, folder).map((wake) => wake.restedMs),
			"a wake a day old goes, and a younger one stays",
		).toEqual([30_000, 5_000]);
	});

	it("notes a wake in a host with the host's key and the limit it parked under, and one whose marker never said when it parked", () => {
		const host = installTestHost("one-background");
		// A drain's marker, saying nothing of when, as an older pi left it.
		const undated = {
			session: SESSION,
			sessionFile: logOf(),
			cwd: "/src",
			addresses: [],
			afterMs: 0,
			pid: HELD_PID,
			wake: join(folder, "held.wake"),
		};
		mkdirSync(join(folder, "parked"), { recursive: true });
		writeFileSync(
			join(folder, "parked", `${SESSION}.json`),
			JSON.stringify(undated),
		);
		try {
			clock = 61_000;
			watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
			}).stop();
			expect(readWakes(SESSION, folder)).toEqual([
				{
					parkedAt: "",
					host: "one-background",
					afterMs: 0,
					wokeAt: new Date(61_000).toISOString(),
					restedMs: 0,
				},
			]);
		} finally {
			host.dispose();
		}
	});

	it("starts, and is parked no more, when its wake can't be noted", () => {
		writeParked(
			{
				session: SESSION,
				sessionFile: logOf(),
				cwd: "/src",
				addresses: [],
				parkedAt: new Date(1_000).toISOString(),
				pid: HELD_PID,
				wake: join(folder, "held.wake"),
			},
			folder,
		);
		// A folder where its file goes: no wake can be written there.
		mkdirSync(join(folder, "wakes", `${SESSION}.json`), { recursive: true });
		const woken: unknown[] = [];
		events.on(SESSION_WOKEN, (data) => woken.push(data));
		clock = 61_000;
		expect(() => watching().stop(), "the start goes on").not.toThrow();
		expect(readParked(SESSION, folder), "its marker is cleared").toBe(
			undefined,
		);
		expect(woken, "it says it woke").toEqual([{ session: SESSION }]);
	});

	it("keeps a hosted conversation awake through a drain when PI_PARK is off for it", () => {
		const host = installTestHost();
		const asked: string[] = [];
		host.host.park = (id) => asked.push(id);
		host.host.draining = () => true;
		try {
			const watched = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
				PI_PARK: "off",
			});
			expect(watched.look()).toBe("parking is off");
			expect(asked).toEqual([]);
		} finally {
			host.dispose();
		}
	});

	it("keeps a hosted conversation awake through a roll when PI_PARK is off for it", () => {
		const host = installTestHost();
		const asked: string[] = [];
		host.host.park = (id) => asked.push(id);
		host.host.rolling = () => true;
		try {
			const watched = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
				PI_PARK: "off",
			});
			expect(watched.look()).toBe("parking is off");
			expect(asked).toEqual([]);
		} finally {
			host.dispose();
		}
	});

	it("keeps a hosted conversation with no log awake, since its host wakes it from its log", () => {
		const host = installTestHost();
		const asked: string[] = [];
		host.host.park = (id) => asked.push(id);
		rmSync(logOf());
		try {
			const watched = watching(session(), {
				MYCELIUM_WAKE: join(folder, "conversation.wake"),
			});
			clock = NAMED_PARK_AFTER_MS;
			expect(watched.look()).toBe("its log isn't written yet");
			expect(asked, "nothing asked the host to park it").toEqual([]);
		} finally {
			host.dispose();
		}
	});

	it("says a person's session with no holder can never park, and nothing of a subagent's", () => {
		const said = noteNeverParks(session(), {}, folder, () => 5000);
		const subagent = noteNeverParks(
			session(),
			{ SUBAGENT_RUN_ID: "fleet-1" },
			folder,
		);

		expect({ said, subagent }).toEqual({ said: true, subagent: false });
		expect(awake()).toEqual({
			session: SESSION,
			why: "no holder would wake it",
			since: new Date(5000).toISOString(),
		});
	});
});

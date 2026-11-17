/**
 * Closing a parking session's window through the desktop's own programs:
 * niri says where it is, the launcher keeps its place, kitty closes it.
 *
 * Each is run from pi's own process, never through a shell command,
 * since the agent fence keeps niri's socket, the shell's ipc and the
 * sessions kitty's remote control from every command an agent runs
 * (`NEVER_THROUGH` in `../fence/fence.ts`). Each is given a few
 * seconds, and one that fails or doesn't answer in time leaves the
 * window open, as parking always left it. They run only as a plain pi
 * parks, idle by then, so waiting on them holds up nothing Joel is
 * doing there.
 *
 * The launcher is asked to keep the window's place asleep
 * (`qs ipc call sessions keepPlaceAsleep <session>`) before it closes,
 * and it closes only on the answer "kept". A place kept asleep opens
 * the window there again once the session wakes, by anything, though
 * never onto the workspace Joel is on (KP0L6A [f3186685]). Just before
 * each window closes, niri is asked again which window is focused, and
 * one Joel has clicked into since the screen was read stays open. Off
 * niri, as on a Mac or in a plain terminal, none of this runs.
 *
 * Every read while the screen is on remembers which workspaces it
 * showed, in a file beside the park markers, since niri names none once
 * it's off, and those count as in sight until it's on again.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../record.ts";
import { parkFolder, type WindowsLeft } from "./park.ts";
import {
	type HeldWindow,
	kittyShows,
	type Screen,
	screenOf,
	shownNow,
	windowVerdict,
} from "./park-window.ts";

/** How long each desktop program may take to answer. */
export const DESKTOP_TIMEOUT_MS = 3_000;

/**
 * How much a desktop program may print. Node's own cap is 1 MB, and
 * kitty's list of 77 windows ran to 1.65 MB.
 */
export const DESKTOP_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The launcher's answer when it has kept a window's place. */
export const KEPT = "kept";

/** Run a program and answer what it printed; throws when it fails. */
export type Run = (program: string, args: readonly string[]) => string;

/** Run a program from this process, with no shell, in a few seconds. */
export const runProgram: Run = (program, args) =>
	execFileSync(program, [...args], {
		encoding: "utf8",
		timeout: DESKTOP_TIMEOUT_MS,
		maxBuffer: DESKTOP_OUTPUT_BYTES,
		stdio: ["ignore", "pipe", "ignore"],
	});

/** How the desktop is reached: its programs, and where what it showed is kept. */
export interface Desk {
	readonly run: Run;
	/** The file remembering the workspaces shown while the screen was on. */
	readonly memory: string;
}

/** This machine's desktop, remembered beside the park markers. */
export function machineDesk(folder: string = parkFolder()): Desk {
	return { run: runProgram, memory: join(folder, "screen.json") };
}

/** Whether this process runs under niri, which says so in its socket. */
export function onNiri(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.NIRI_SOCKET);
}

function remembered(memory: string): number[] {
	try {
		const kept: unknown = JSON.parse(readFileSync(memory, "utf8"));
		if (!isRecord(kept) || !Array.isArray(kept.shown)) return [];
		return kept.shown.filter((one): one is number => typeof one === "number");
	} catch {
		// Nothing remembered yet, or a file half written: nothing is known.
		return [];
	}
}

function remember(memory: string, shown: readonly number[]): void {
	try {
		writeFileSync(
			memory,
			`${JSON.stringify({ shown, at: new Date().toISOString() })}\n`,
		);
	} catch {
		// Unremembered, an off screen spares only what niri itself says.
	}
}

/**
 * What niri shows, or nothing when it can't be read. Read while the
 * screen is on, it remembers the workspaces shown; read while it's off,
 * it carries those remembered.
 */
export function readScreen(desk: Desk): Screen | undefined {
	let screen: Screen;
	try {
		screen = screenOf(
			JSON.parse(desk.run("niri", ["msg", "--json", "windows"])),
			JSON.parse(desk.run("niri", ["msg", "--json", "workspaces"])),
		);
	} catch {
		// niri didn't answer, or answered something else: nothing is known.
		return undefined;
	}
	const shown = shownNow(screen);
	if (shown !== undefined) {
		remember(desk.memory, shown);
		return screen;
	}
	return { ...screen, remembered: remembered(desk.memory) };
}

/**
 * Ask the launcher to keep where `session`'s window sits while it
 * sleeps, answering what it said, "kept" when it did, or why it couldn't
 * be asked.
 */
export function keepPlaceAsleep(session: string, run: Run): string {
	try {
		return run("qs", [
			"ipc",
			"call",
			"sessions",
			"keepPlaceAsleep",
			session,
		]).trim();
	} catch {
		// No shell, or one that doesn't take the call yet: the place isn't kept.
		return "the launcher didn't answer";
	}
}

/**
 * The app id of the window niri has focused now, "" for none, or
 * nothing when niri can't say.
 */
function focusedNow(run: Run): string | undefined {
	try {
		const window: unknown = JSON.parse(
			run("niri", ["msg", "--json", "focused-window"]),
		);
		if (window === null) return "";
		if (!isRecord(window)) return undefined;
		return typeof window.app_id === "string" ? window.app_id : "";
	} catch {
		// niri didn't answer: what is focused can't be known.
		return undefined;
	}
}

/**
 * Close `window` in its kitty, once niri says it isn't focused and kitty
 * shows it in an OS window of its class; answers why not, when it
 * couldn't.
 */
export function closeWindow(window: HeldWindow, run: Run): string | undefined {
	const focused = focusedNow(run);
	if (focused === undefined) return "niri can't say which window is focused";
	if (focused !== "" && focused === window.appId) {
		return "its window was focused as it would have closed";
	}
	try {
		const ls: unknown = JSON.parse(
			run("kitten", [
				"@",
				"--to",
				window.within,
				"ls",
				"--match",
				`id:${window.id}`,
			]),
		);
		if (!kittyShows(ls, window)) {
			return `kitty shows no window ${window.id} of class ${window.appId}`;
		}
		run("kitten", [
			"@",
			"--to",
			window.within,
			"close-window",
			"--match",
			`id:${window.id}`,
		]);
		return undefined;
	} catch {
		return `kitty didn't close window ${window.id}`;
	}
}

/**
 * Why a parking session must stay awake for its windows: one is focused
 * or in sight. Anything else, even a screen that can't be read, lets it
 * park, leaving open what can't be closed.
 */
export function inSight(
	windows: readonly HeldWindow[],
	desk: Desk,
): string | undefined {
	if (windows.length === 0) return undefined;
	const screen = readScreen(desk);
	if (screen === undefined) return undefined;
	const verdict = windowVerdict(windows, screen);
	return verdict.kind === "in-sight" ? verdict.why : undefined;
}

/**
 * What became of a parking session's windows: kept open because one is
 * in sight, or closed as far as could be, saying why any stayed open.
 */
export type Leaving =
	| { readonly kind: "refused"; readonly why: string }
	| {
			readonly kind: "parks";
			readonly closed: readonly HeldWindow[];
			readonly open?: string;
	  };

/**
 * What a parked marker keeps of a leaving: the windows closed, and why
 * any stayed open, a refusal included, since by then it parks anyway.
 */
export function leftOf(leaving: Leaving): WindowsLeft {
	if (leaving.kind === "refused") return { closed: [], open: leaving.why };
	return {
		closed: leaving.closed.map(({ id, appId }) => ({ id, appId })),
		...(leaving.open !== undefined ? { open: leaving.open } : {}),
	};
}

/**
 * Close the windows a parking session shows in, where none is in sight:
 * any focused, or on a workspace shown, closes none. The launcher keeps
 * their place asleep first, and they close only once it says "kept".
 */
export function leaveScreen(
	session: string,
	windows: readonly HeldWindow[],
	desk: Desk,
): Leaving {
	if (windows.length === 0) return { kind: "parks", closed: [] };
	const screen = readScreen(desk);
	if (screen === undefined) {
		return { kind: "parks", closed: [], open: "niri can't be read" };
	}
	const verdict = windowVerdict(windows, screen);
	if (verdict.kind === "in-sight") return { kind: "refused", why: verdict.why };
	if (verdict.kind === "leave") {
		return { kind: "parks", closed: [], open: verdict.why };
	}
	if (verdict.kind === "none") return { kind: "parks", closed: [] };
	const kept = keepPlaceAsleep(session, desk.run);
	if (kept !== KEPT) {
		return {
			kind: "parks",
			closed: [],
			open: `the launcher didn't keep its place: ${kept}`,
		};
	}
	const closed: HeldWindow[] = [];
	for (const window of verdict.windows) {
		const why = closeWindow(window, desk.run);
		if (why !== undefined) return { kind: "parks", closed, open: why };
		closed.push(window);
	}
	return { kind: "parks", closed };
}

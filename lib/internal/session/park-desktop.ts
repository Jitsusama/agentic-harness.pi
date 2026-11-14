/**
 * Closing a parking session's window through the desktop's own programs:
 * niri says where it is, the launcher keeps its place, kitty closes it.
 *
 * Each is run from pi's own process, never through a shell command,
 * since the agent fence keeps niri's socket, the shell's ipc and the
 * sessions kitty's remote control from every command an agent runs
 * (`NEVER_THROUGH` in fence.ts). Each is given a few seconds, and one
 * that fails or doesn't answer in time leaves the window open, as
 * parking always left it.
 *
 * The launcher is asked to keep the window's place
 * (`qs ipc call sessions keepPlace <session>`) before it closes, and it
 * closes only on the answer "kept", so Agents can open it again where it
 * was. Off niri, as on a Mac or in a plain terminal, none of this runs.
 */

import { execFileSync } from "node:child_process";
import {
	type HeldWindow,
	kittyShows,
	type Screen,
	screenOf,
	windowVerdict,
} from "./park-window.ts";

/** How long each desktop program may take to answer. */
export const DESKTOP_TIMEOUT_MS = 3_000;

/** The launcher's answer when it has kept a window's place. */
export const KEPT = "kept";

/** Run a program and answer what it printed; throws when it fails. */
export type Run = (program: string, args: readonly string[]) => string;

/** Run a program from this process, with no shell, in a few seconds. */
export const runProgram: Run = (program, args) =>
	execFileSync(program, [...args], {
		encoding: "utf8",
		timeout: DESKTOP_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
	});

/** Whether this process runs under niri, which says so in its socket. */
export function onNiri(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.NIRI_SOCKET);
}

/** What niri shows, or nothing when it can't be read. */
export function readScreen(run: Run = runProgram): Screen | undefined {
	try {
		return screenOf(
			JSON.parse(run("niri", ["msg", "--json", "windows"])),
			JSON.parse(run("niri", ["msg", "--json", "workspaces"])),
		);
	} catch {
		// niri didn't answer, or answered something else: nothing is known.
		return undefined;
	}
}

/**
 * Ask the launcher to keep where `session`'s window sits, answering what
 * it said, "kept" when it did, or why it couldn't be asked.
 */
export function keepPlace(session: string, run: Run = runProgram): string {
	try {
		return run("qs", ["ipc", "call", "sessions", "keepPlace", session]).trim();
	} catch {
		// No shell, or one that didn't answer: the place isn't kept.
		return "the launcher didn't answer";
	}
}

/**
 * Close `window` in its kitty, once kitty shows it in an OS window of
 * its class; answers why not, when it couldn't.
 */
export function closeWindow(
	window: HeldWindow,
	run: Run = runProgram,
): string | undefined {
	try {
		const ls: unknown = JSON.parse(
			run("kitten", ["@", "--to", window.within, "ls"]),
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
 * What became of a parking session's windows: kept awake because one is
 * in sight, or parked, closing those it could and saying why it left any
 * open.
 */
export type Leaving =
	| { readonly kind: "refused"; readonly why: string }
	| {
			readonly kind: "parks";
			readonly closed: readonly HeldWindow[];
			readonly open?: string;
	  };

/**
 * Close the windows a parking session shows in, where none is in sight:
 * any focused, or on a workspace shown on an output, refuses the park.
 * The launcher keeps their place first, and they close only once it
 * says "kept".
 */
export function leaveScreen(
	session: string,
	windows: readonly HeldWindow[],
	run: Run = runProgram,
): Leaving {
	if (windows.length === 0) return { kind: "parks", closed: [] };
	const screen = readScreen(run);
	if (screen === undefined) {
		return { kind: "parks", closed: [], open: "niri can't be read" };
	}
	const verdict = windowVerdict(windows, screen);
	if (verdict.kind === "in-sight") return { kind: "refused", why: verdict.why };
	if (verdict.kind === "leave") {
		return { kind: "parks", closed: [], open: verdict.why };
	}
	if (verdict.kind === "none") return { kind: "parks", closed: [] };
	const kept = keepPlace(session, run);
	if (kept !== KEPT) {
		return {
			kind: "parks",
			closed: [],
			open: `the launcher didn't keep its place: ${kept}`,
		};
	}
	const closed: HeldWindow[] = [];
	for (const window of verdict.windows) {
		const why = closeWindow(window, run);
		if (why !== undefined) return { kind: "parks", closed, open: why };
		closed.push(window);
	}
	return { kind: "parks", closed };
}

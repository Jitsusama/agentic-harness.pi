/**
 * Opening a session's window in the desktop's sessions kitty, as the
 * launcher would, for when the launcher can't take it.
 *
 * On a machine whose desktop keeps one kitty for every pi window
 * (core.nix's sessions-kitty.service, instance group `pi-sessions`),
 * the launcher opens each window there, unfocused, where it can place
 * and find it again. A window opened anywhere else is outside all of
 * that: on 10 November at 13:28 the shell answered a hand-over too late,
 * and two spawns opened plain kitty windows of their own outside it
 * (Y2YBTS [9f93dcd0]). So when the launcher isn't there to take one,
 * the window is opened in that kitty the way the launcher and cadence
 * open theirs: `kitty -1 --instance-group pi-sessions` with the class
 * niri opens unfocused, in a scope of its own under the agents' slice,
 * without the activation token niri would spend on taking the focus,
 * and its login shell running the command under the realm's holder.
 */

import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import {
	launchEnvironment,
	shellQuote,
	typedLine,
} from "../../core/internal/terminal/drivers/shared.ts";
import { startDetached } from "../../core/internal/terminal/launchers.ts";
import { AGENTS_SLICE, SPAWNED_CLASS } from "../../terminal/types.ts";

/** The instance group the desktop's sessions kitty answers for. */
export const SESSIONS_GROUP = "pi-sessions";

/**
 * Variables never handed to the window: the activation token, which
 * kitty would spend on taking the focus as its window shows.
 */
const FOCUS_VARIABLES = ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"];

/**
 * Whether the sessions kitty runs for this user, by the socket kitty's
 * single instance listens on for its group. Without /proc to read, as
 * on macOS, there is none. `PI_SESSIONS_KITTY` says so outright, `off`
 * or `on`: the test suite sets it off, so no test opens a window on the
 * desktop it runs on.
 */
export function sessionsKittyRuns(
	read: () => string = () => readFileSync("/proc/net/unix", "utf8"),
	uid: number = userInfo().uid,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	if (env.PI_SESSIONS_KITTY === "off") return false;
	if (env.PI_SESSIONS_KITTY === "on") return true;
	let sockets: string;
	try {
		sockets = read();
	} catch {
		// No /proc/net/unix: no Linux desktop keeping a sessions kitty.
		return false;
	}
	const name = `@kitty-ipc-${uid}-${SESSIONS_GROUP}`;
	return sockets.split("\n").some((line) => line.trimEnd().endsWith(name));
}

/** A window to open in the sessions kitty. */
export interface SessionsKittyWindow {
	/** The shell command the window runs, as a spawn resolved it. */
	readonly command: string;
	readonly cwd: string;
	/** Variables the session needs beyond the person's own. */
	readonly env?: Readonly<Record<string, string>>;
}

/** What the window is opened with: the program, its arguments and environment. */
export interface SessionsKittyStart {
	readonly binary: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

/**
 * How `window` is started in the sessions kitty from a session whose
 * environment is `from`: held by its realm's mycelium, when the
 * session is in one, so closing the window leaves the session running.
 * Its own variables go on its command line, since kitty's one instance
 * opens the window, and the person's startup files are read first, which
 * puts the right pi on PATH.
 */
export function sessionsKittyStart(
	window: SessionsKittyWindow,
	from: Readonly<Record<string, string | undefined>>,
): SessionsKittyStart {
	const realm = from.MYCELIUM_REALM?.trim();
	const held = realm
		? `mycelium --realm ${shellQuote(realm)} hold -- ${window.command}`
		: window.command;
	const shell = from.SHELL ?? "/bin/sh";
	const line = typedLine(held, window.env, true).trimEnd();
	const env = launchEnvironment(from);
	for (const name of FOCUS_VARIABLES) delete env[name];
	return {
		binary: "systemd-run",
		args: [
			"--user",
			"--scope",
			"--collect",
			"--quiet",
			`--slice=${AGENTS_SLICE}`,
			"--",
			"kitty",
			"-1",
			"--instance-group",
			SESSIONS_GROUP,
			"--class",
			SPAWNED_CLASS,
			"--directory",
			window.cwd,
			shell,
			"-l",
			"-i",
			"-c",
			line,
		],
		env,
	};
}

/** Starts a program detached, failing when it fails at once. */
export type StartDetached = (start: SessionsKittyStart) => Promise<void>;

const detached: StartDetached = (start) =>
	startDetached(start.binary, start.args, { env: start.env });

/**
 * Open `window` in the sessions kitty, answering what was opened, in
 * the words a spawn's answer gives it.
 */
export async function openInSessionsKitty(
	window: SessionsKittyWindow,
	from: Readonly<Record<string, string | undefined>> = process.env,
	start: StartDetached = detached,
): Promise<string> {
	await start(sessionsKittyStart(window, from));
	return `a window in the desktop's sessions kitty, in ${window.cwd}`;
}

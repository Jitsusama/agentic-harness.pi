/**
 * Opening a session's window in the desktop's sessions kitty, as the
 * launcher would, for when the launcher can't take it.
 *
 * On a machine whose desktop keeps one kitty for every pi window
 * (core.nix's sessions-kitty.service), the launcher opens each window
 * there, unfocused, where it can place and find it again. A window
 * opened anywhere else is outside all of that: on 10 November at 13:28
 * the shell answered a hand-over too late, and two spawns opened plain
 * kitty windows of their own outside it (Y2YBTS [9f93dcd0]). So when
 * the launcher isn't there to take one, the window is opened in that
 * kitty the way the launcher and cadence open theirs, with the class
 * niri opens unfocused and its login shell running the command under
 * the realm's holder.
 *
 * It's asked by remote control over the socket that kitty listens on in
 * the login's runtime folder, `pi-sessions/kitty.sock`, which the agent
 * fence hides from every command it runs. It was asked through kitty's
 * single instance, `kitty -1 --instance-group pi-sessions`, which hands
 * the asker's whole environment to whatever holds an abstract socket
 * name; a fenced command can bind that name once nothing holds it, and
 * Landlock refuses connecting to one but not binding it (ISXEG8
 * [ba85dd3b]). A remote launch gives the window kitty's own environment
 * and only the variables named here, never the asker's.
 *
 * A sessions kitty started before the socket came holds the single
 * instance's name until the next login, so while its unit runs, and only
 * then, a window still goes that way: its unit running is said by its
 * cgroup holding a process, which no fenced command can change.
 * Neither, and there is no sessions kitty to open in.
 *
 * Each window gets a class of its own, told to it in `MYCELIUM_APP_ID`
 * as well, as the launcher's own windows are (core.nix's Sessions.qml,
 * inSessions). One kitty draws every window there, so a bare class
 * names none of them: on 11 November 48 of 58 pi windows sat in it as
 * `pi-spawned`, and nothing could tie the window Joel was at to its pi
 * (7QEY1S [12aa2de1]).
 */

import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
	launchEnvironment,
	shellQuote,
	typedLine,
} from "../../core/internal/terminal/drivers/shared.ts";
import { startDetached } from "../../core/internal/terminal/launchers.ts";
import { classOfItsOwn } from "../../terminal/niri.ts";
import { AGENTS_SLICE } from "../../terminal/types.ts";
import { runtimeDir } from "../paths.ts";

/** The instance group a sessions kitty started before its socket answers for. */
const SESSIONS_GROUP = "pi-sessions";

/** Where the sessions kitty takes remote launches, in the runtime folder. */
export const SESSIONS_SOCKET = join("pi-sessions", "kitty.sock");

/**
 * Variables never handed to the window: the activation token, which
 * kitty would spend on taking the focus as its window shows.
 */
const FOCUS_VARIABLES = ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"];

/**
 * How a window reaches the sessions kitty: by remote control over its
 * socket, or through its single instance while one started before the
 * socket still runs as its unit.
 */
export type SessionsKittyDoor =
	| { readonly kind: "socket"; readonly path: string }
	| { readonly kind: "instance" };

/** What the door is found by; this machine's own unless given. */
export interface SessionsKittyProbe {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly uid?: number;
	readonly isSocket?: (path: string) => boolean;
	/** The processes in a cgroup, as its `cgroup.procs` lists them. */
	readonly processesIn?: (cgroup: string) => string;
}

const isSocket = (path: string): boolean => {
	try {
		return statSync(path).isSocket();
	} catch {
		// Nothing there, or nothing this login may look at: no socket.
		return false;
	}
};

const processesIn = (cgroup: string): string => {
	try {
		return readFileSync(join(cgroup, "cgroup.procs"), "utf8");
	} catch {
		// No such cgroup, as when the unit isn't running: no processes.
		return "";
	}
};

/**
 * The cgroup of the sessions kitty's unit, which systemd starts in the
 * agents' slice.
 */
function sessionsKittyCgroup(uid: number): string {
	return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/${AGENTS_SLICE}/sessions-kitty.service`;
}

/**
 * How a window reaches the sessions kitty for this login, or undefined
 * when there is none. `PI_SESSIONS_KITTY` says so outright, `off` or
 * `on`: the test suite sets it off, so no test opens a window on the
 * desktop it runs on.
 */
export function sessionsKittyDoor(
	probe: SessionsKittyProbe = {},
): SessionsKittyDoor | undefined {
	const env = probe.env ?? process.env;
	if (env.PI_SESSIONS_KITTY === "off") return undefined;
	const runtime = runtimeDir(env);
	const socket = runtime ? join(runtime, SESSIONS_SOCKET) : undefined;
	if (
		socket &&
		(env.PI_SESSIONS_KITTY === "on" || (probe.isSocket ?? isSocket)(socket))
	) {
		return { kind: "socket", path: socket };
	}
	const cgroup = sessionsKittyCgroup(probe.uid ?? userInfo().uid);
	return (probe.processesIn ?? processesIn)(cgroup).trim() === ""
		? undefined
		: { kind: "instance" };
}

/** Whether there is a sessions kitty for this login to open a window in. */
export function sessionsKittyRuns(probe: SessionsKittyProbe = {}): boolean {
	return sessionsKittyDoor(probe) !== undefined;
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
	/** The window's class, and the app id niri lists it by. */
	readonly windowClass: string;
}

/** The variable a window's class is told to what runs in it. */
const APP_ID_VARIABLE = "MYCELIUM_APP_ID";

/**
 * How `window` is started in the sessions kitty through `door` from a
 * session whose environment is `from`: held by its realm's mycelium,
 * when the session is in one, so closing the window leaves the session
 * running. Its own variables go on its command line, since kitty opens
 * the window, and the person's startup files are read first, which puts
 * the right pi on PATH. The window is told only its class besides.
 */
export function sessionsKittyStart(
	window: SessionsKittyWindow,
	from: Readonly<Record<string, string | undefined>>,
	door: SessionsKittyDoor,
	windowClass: string = classOfItsOwn(),
): SessionsKittyStart {
	const realm = from.MYCELIUM_REALM?.trim();
	const held = realm
		? `mycelium --realm ${shellQuote(realm)} hold -- ${window.command}`
		: window.command;
	const shell = from.SHELL ?? "/bin/sh";
	// The holder reads the class and keeps it from its program; with no
	// holder, a session this one spawns would say it as its own window's.
	const line = `${realm ? "" : `unset ${APP_ID_VARIABLE}\n`}${typedLine(
		held,
		window.env,
		true,
	).trimEnd()}`;
	const env = launchEnvironment(from);
	for (const name of FOCUS_VARIABLES) delete env[name];
	if (door.kind === "socket") {
		// The mycelium holder names a held session's window by the class it
		// reads from its own environment, so Go To finds it again.
		return {
			binary: "kitten",
			args: [
				"@",
				"--to",
				`unix:${door.path}`,
				"launch",
				"--type=os-window",
				"--os-window-class",
				windowClass,
				"--cwd",
				window.cwd,
				"--env",
				`${APP_ID_VARIABLE}=${windowClass}`,
				shell,
				"-l",
				"-i",
				"-c",
				line,
			],
			env,
			windowClass,
		};
	}
	return {
		binary: "systemd-run",
		args: [
			"--user",
			"--scope",
			"--collect",
			"--quiet",
			`--slice=${AGENTS_SLICE}`,
			"--",
			"env",
			`${APP_ID_VARIABLE}=${windowClass}`,
			"kitty",
			"-1",
			"--instance-group",
			SESSIONS_GROUP,
			"--class",
			windowClass,
			"--directory",
			window.cwd,
			shell,
			"-l",
			"-i",
			"-c",
			line,
		],
		env,
		windowClass,
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
	find: () => SessionsKittyDoor | undefined = () =>
		sessionsKittyDoor({ env: from }),
): Promise<string> {
	const door = find();
	if (!door) throw new Error("there is no sessions kitty to open a window in");
	await start(sessionsKittyStart(window, from, door));
	return `a window in the desktop's sessions kitty, in ${window.cwd}`;
}

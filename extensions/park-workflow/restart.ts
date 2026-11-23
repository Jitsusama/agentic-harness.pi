/**
 * Ending plain pi's process for its holder: starting it again in place on
 * a log, exiting with the code that says it parked, and making sure the
 * holder wakes it into the same session.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, writeFileSync } from "node:fs";
import {
	flagsLost,
	holderCommand,
	holderRecord,
	opensOnlyItself,
	PARK_SAID_ENV,
	restartCommand,
} from "../../lib/internal/session/park.ts";

/** What a window shows as its session starts again on a fresh log. */
export const RESTART_LINE =
	"Starting again on its fresh log, to give back what the old one held.";

/** The variables a spawn handed this pi for its first start alone. */
const FIRST_START_ONLY = [
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"QUEST_WORKFLOW_AUTOLOAD_ID",
	"QUEST_WORKFLOW_FIRST_WORDS",
];

/**
 * Once pi exits, replace this process with a fresh pi on `sessionFile`,
 * in place: the same pid, terminal and holder, so the holder never sees
 * an exit and says nothing of a park. One that can't be replaced runs
 * `fallback`, which has its holder start it again instead.
 */
export function restartWith(sessionFile: string, fallback: () => void): void {
	process.once("exit", () => {
		process.stdout.write(`\r\n${RESTART_LINE}\r\n`);
		const env = restartEnvironment(process.env, process.pid);
		const [script = ""] = process.argv.slice(1);
		// Node calls execve experimental and would print so in the window.
		process.removeAllListeners("warning");
		replaceInPlace(
			process.execve?.bind(process),
			[
				process.execPath,
				...process.execArgv,
				script,
				...restartCommand(sessionFile, process.argv.slice(2)).slice(1),
			],
			env,
		);
		// Not replaced: its holder starts it again instead.
		fallback();
	});
}

/**
 * The variables the pi a restart in place of process `pid` becomes
 * runs with: `env` without those a spawn gave its first start alone,
 * and naming `pid` as the process that said its park, for that pi to
 * take back as it loads.
 */
export function restartEnvironment(
	env: NodeJS.ProcessEnv,
	pid: number,
): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...env, [PARK_SAID_ENV]: String(pid) };
	for (const name of FIRST_START_ONLY) delete next[name];
	return next;
}

/**
 * Replaces this process with `argv` by `execve`. It returns only when it
 * couldn't, as on a Node without execve, where `argv[0]` can't be run,
 * or when execve throws, for the caller to start it another way.
 *
 * Node ends the process by abort, never returning, when the execve call
 * itself fails (PV3TE0 saw ENOENT do so on node 24, 21 November), so
 * the program is checked first: Node upgraded or collected under a
 * long-running pi is the likeliest way it fails, and that way the
 * caller's fallback still runs.
 */
export function replaceInPlace(
	execve: NodeJS.Process["execve"],
	argv: readonly [string, ...string[]],
	env: NodeJS.ProcessEnv,
	canRun: (file: string) => boolean = runnable,
): void {
	if (execve === undefined || !canRun(argv[0])) return;
	try {
		execve(argv[0], argv, env);
	} catch {
		// Not replaced: the process runs on as it was, and the caller knows.
	}
}

/** Whether this account may run `file`. */
function runnable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The app id of the window niri has focused, or null when niri can't be
 * asked, as off Linux or outside niri.
 */
export function niriFocused(): string | null {
	try {
		const out = execFileSync("niri", ["msg", "--json", "focused-window"], {
			encoding: "utf8",
			timeout: 2_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const window: unknown = JSON.parse(out);
		if (window === null) return "";
		if (typeof window !== "object" || !("app_id" in window)) return null;
		return typeof window.app_id === "string" ? window.app_id : "";
	} catch {
		// No niri to ask, or one that didn't answer: focus can't be told.
		return null;
	}
}

/** The app ids of the windows a holder's record says show this session. */
export function shownIn(wake: string): string[] | undefined {
	const record = holderRecord(wake);
	// A record missing or half written can't say where it shows.
	if (!record) return undefined;
	const windows = "windows" in record ? record.windows : [];
	if (!Array.isArray(windows)) return undefined;
	return windows.map((window: unknown) =>
		typeof window === "object" &&
		window !== null &&
		"app_id" in window &&
		typeof window.app_id === "string"
			? window.app_id
			: "",
	);
}

/**
 * Say to the process that, whatever pi exits with, it exits with this,
 * leaving `line` in its window.
 */
export function exitWith(code: number): void {
	// pi ends a quit with process.exit(0); an exit listener's code wins.
	// The window stays with its holder, which says it parked, so this
	// writes nothing: a line of its own said it twice (KP0L6A, 11 November).
	process.once("exit", () => {
		process.exitCode = code;
	});
}

/**
 * Leave out pi's "To resume this session" hint as a pi its holder will
 * start again exits: the holder brings the session back itself, and says
 * so in the window, so the hint only pushed his last screen up. pi prints
 * it only while stdout is a terminal, and asks once its screen has stopped
 * and every session_shutdown handler has run, so nothing after reads it.
 */
export function hideResumeHint(): void {
	Object.defineProperty(process.stdout, "isTTY", {
		value: false,
		configurable: true,
	});
}

/**
 * Make sure its holder wakes this session into itself: by naming the
 * command that opens its log, or, for a holder that takes none, by the
 * command it runs already opening it. Answers why not otherwise.
 */
export function restartNamed(
	again: string,
	args: readonly string[],
	session: string,
	sessionFile: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const unwritten = logWritten(sessionFile);
	if (unwritten !== undefined) return unwritten;
	if (again === "") {
		return opensOnlyItself(args, session, sessionFile)
			? undefined
			: "its holder would start it as a new session";
	}
	const lost = flagsLost(args);
	if (lost.length > 0) return `starting again would drop ${lost.join(", ")}`;
	try {
		writeFileSync(again, JSON.stringify(holderCommand(sessionFile, args, env)));
		return undefined;
	} catch {
		return "its holder couldn't be told how to start it again";
	}
}

/**
 * Why a session can't start again from its log, if it can't: pi writes a
 * log at its first answer, so one never asked anything would wake as a
 * new session, under another address.
 */
export function logWritten(sessionFile: string): string | undefined {
	if (sessionFile === "") return "it has no log to start again from";
	if (!existsSync(sessionFile)) return "its log isn't written yet";
	return undefined;
}

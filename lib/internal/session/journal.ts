/**
 * Writing a line to the system's log: the journal on Linux, the unified
 * log on macOS, under the identifier `pi`.
 *
 * A dying pi writes and waits, since the process ends straight after;
 * a living one writes and carries on, since nothing it does should wait
 * on a log.
 */

import { spawn, spawnSync } from "node:child_process";
import { systemFolders, systemProgram } from "../system-program.ts";

/** What writes to the system's log, and the arguments it takes. */
export interface JournalCommand {
	program: string;
	args: string[];
}

/** How loud a line is: an error, or news. */
export type JournalLevel = "err" | "info";

/** The longest a journal write may hold a dying process up. */
const JOURNAL_WAIT_MS = 2_000;

/**
 * How to write to the system's log at `level`: systemd-cat into the
 * journal on Linux, logger into the unified log on macOS, each found
 * only where the system put it; nothing when neither is there.
 */
export function journalCommand(
	level: JournalLevel,
	find: (program: string, folders: readonly string[]) => string | undefined = (
		program,
		folders,
	) => systemProgram(program, folders),
): JournalCommand | undefined {
	const cat = find("systemd-cat", systemFolders());
	if (cat) return { program: cat, args: ["-t", "pi", "-p", level] };
	const logger = find("logger", ["/usr/bin", ...systemFolders()]);
	if (logger)
		return { program: logger, args: ["-t", "pi", "-p", `user.${level}`] };
	return undefined;
}

/** Writes `text` to the system's log and waits for it, briefly. */
export function writeJournal(
	text: string,
	command: JournalCommand | undefined,
): void {
	if (!command) return;
	spawnSync(command.program, command.args, {
		input: text,
		stdio: ["pipe", "ignore", "ignore"],
		timeout: JOURNAL_WAIT_MS,
	});
}

/** Writes `text` to the system's log without waiting for it. */
export function sayInJournal(
	text: string,
	command: JournalCommand | undefined,
): void {
	if (!command) return;
	const child = spawn(command.program, command.args, {
		stdio: ["pipe", "ignore", "ignore"],
	});
	// A log that can't be written to loses one line of news, which is
	// all it would have held; the session goes on as it was.
	child.on("error", () => undefined);
	child.stdin.on("error", () => undefined);
	child.stdin.end(text);
	child.unref();
}

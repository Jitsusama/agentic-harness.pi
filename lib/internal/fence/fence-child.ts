/**
 * Running a fenced command's shell as pi-fence's child, so that what
 * ends pi-fence ends the command too.
 *
 * On 17 November a timed-out run on the Mac left its sandboxed command
 * running: the caller's signal ended pi-fence alone, since it waited on
 * the shell synchronously and could hear nothing. So the shell now runs
 * in a process group of its own, and the signals a caller ends a run
 * with (SIGTERM, SIGHUP, SIGALRM, SIGINT) are passed to that whole
 * group: the shell, the sandbox and everything the command started,
 * which a shell with no job control keeps in its group. Such a shell
 * starts its background commands ignoring SIGINT, so once the shell has
 * ended by a signal passed on, what is left of its group is sent
 * SIGTERM: the run is over. pi-fence then ends as the command did.
 *
 * Run from a terminal, the shell stays in pi-fence's group, the
 * terminal's foreground one, so it can still read the keyboard; the
 * terminal sends Ctrl-C to everyone in that group already, so only the
 * other signals are passed on, to the shell alone. A command that leaves
 * its group on purpose (setsid) is past this, as past any group signal.
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";

/** The status a signal's end gives, as a shell reports it. */
const SIGNALLED = 128;

/** The status a command that ends with neither a status nor a signal gives. */
const UNKNOWN_END = 1;

/** The signals a caller ends a run with, passed on to the command. */
const ENDING = ["SIGTERM", "SIGHUP", "SIGALRM", "SIGINT"] as const;

/** How a fenced command's shell ended, or why it never started. */
export type ChildEnd = { readonly code: number } | { readonly error: string };

/**
 * Run `text` with bash in `folder`, wiring its stdio to this process's,
 * and pass on each ending signal this process hears until the shell ends.
 */
export function runForwarding(text: string, folder: string): Promise<ChildEnd> {
	const fromTerminal = process.stdin.isTTY === true;
	const shell = spawn("bash", ["-c", text], {
		cwd: folder,
		stdio: "inherit",
		detached: !fromTerminal,
	});
	let passed = false;
	const signalGroup = (signal: NodeJS.Signals) => {
		if (shell.pid === undefined) return;
		try {
			process.kill(fromTerminal ? shell.pid : -shell.pid, signal);
		} catch {
			// The group ended before the signal: nothing is left to end.
		}
	};
	const passOn = (signal: NodeJS.Signals) => {
		if (shell.exitCode !== null || shell.signalCode !== null) return;
		passed = true;
		// From a terminal, Ctrl-C reached the shell's group already.
		if (fromTerminal && signal === "SIGINT") return;
		signalGroup(signal);
	};
	for (const signal of ENDING) process.on(signal, passOn);
	const stopPassing = () => {
		for (const signal of ENDING) process.off(signal, passOn);
	};
	return new Promise((done) => {
		shell.once("error", (error) => {
			stopPassing();
			done({ error: error.message });
		});
		shell.once("exit", (code, signal) => {
			stopPassing();
			if (passed && !fromTerminal) signalGroup("SIGTERM");
			const number = signal ? constants.signals[signal] : undefined;
			done({
				code: number === undefined ? (code ?? UNKNOWN_END) : SIGNALLED + number,
			});
		});
	});
}

/**
 * Running a fenced command's shell as pi-fence's child, so that what
 * ends pi-fence ends the command too.
 *
 * On 17 November a timed-out run on the Mac left its sandboxed command
 * running: the caller's signal ended pi-fence alone, since it waited on
 * the shell synchronously and could hear nothing, and sandbox-exec,
 * unlike bubblewrap, doesn't die with its parent. So the shell now runs
 * in a session and process group of its own, which a shell with no job
 * control keeps everything it starts in: the sandbox and the command.
 *
 * Two things end that group. The signals a caller ends a run with
 * (SIGTERM, SIGHUP, SIGALRM, SIGINT) are passed on to it; one that
 * hasn't ended the shell within a grace is followed by SIGKILL, so a
 * command that ignores it can't keep the run going. And a watcher in
 * the group holds a pipe from pi-fence: once pi-fence is gone, however
 * it went, SIGKILL to its process group included, the pipe closes and
 * the watcher kills the group, as bubblewrap's --die-with-parent does
 * on Linux. The watcher ignores the signals passed on, or the first
 * one would end it before what outlasts the shell, and is nobody's
 * child, so a program that waits for all its children never waits on
 * it. So nothing a run started outlives it, the command's own
 * background work included, which then ends by SIGKILL as a sandbox's
 * does on Linux, where bubblewrap's pid namespace ends with its first
 * process and a passed signal ends the sandbox at once. pi-fence then
 * ends as the command did, or,
 * ended by a caller's signal, dies by that same signal, so a calling
 * shell sees Ctrl-C as Ctrl-C.
 *
 * Run with the keyboard (stdin on a terminal), the shell stays in
 * pi-fence's group, the terminal's foreground one, so it can still read
 * it and /dev/tty; a new session would lose them. There no watcher
 * runs, since that group holds the rest of the person's pipeline, the
 * other ending signals go to the shell alone, and SIGINT isn't passed
 * on nor followed by a kill: Ctrl-C already reached the whole group,
 * and a program may take it as cancel. A run whose stdin is piped loses
 * /dev/tty prompts, which agents never answer; a SIGINT sent to
 * pi-fence alone on a terminal run goes unheard. This contains
 * accidents, not a hostile command, which can leave its group (setsid).
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { isatty } from "node:tty";

/** The status a signal's end gives, as a shell reports it. */
const SIGNALLED = 128;

/** The status a command that ends with neither a status nor a signal gives, as pi-fence's own refusals. */
const UNKNOWN_END = 126;

/** The signals a caller ends a run with, passed on to the command. */
const ENDING = ["SIGTERM", "SIGHUP", "SIGALRM", "SIGINT"] as const;

/** How long a command has to end once told, before it is killed. */
export const GRACE_MS = 5000;

/**
 * What the shell runs first, outside the sandbox: a watcher that waits
 * for the pipe on descriptor 3 to close, which happens only when
 * pi-fence is gone, and then kills its own process group (`kill 0`).
 * The shell ignores the ending signals while it starts the watcher, so
 * the watcher ignores them from its first instant, and starts it from a
 * subshell that ends at once, so it is nobody's child; then the shell
 * takes them back. One passed in that moment is lost, and the grace's
 * SIGKILL ends the run. The command itself runs without descriptor 3.
 */
const WATCHER = [
	"trap '' TERM HUP ALRM INT",
	"( { read -r _ <&3; kill -KILL 0; } </dev/null >/dev/null 2>&1 3<&3 & )",
	"trap - TERM HUP ALRM INT",
	"exec 3<&-",
	"",
].join("\n");

/** How a fenced command's shell ended, or why it never started. */
export type ChildEnd =
	| { readonly code: number }
	| { readonly signal: NodeJS.Signals }
	| { readonly error: string };

/**
 * Run `text` with bash in `folder`, wiring its stdio to this process's,
 * and pass on each ending signal this process hears until the shell ends.
 */
export function runForwarding(text: string, folder: string): Promise<ChildEnd> {
	const fromTerminal = isatty(0);
	const shell = spawn("bash", ["-c", fromTerminal ? text : WATCHER + text], {
		cwd: folder,
		stdio: fromTerminal ? "inherit" : ["inherit", "inherit", "inherit", "pipe"],
		detached: !fromTerminal,
	});
	// The pipe's far end closes when the watcher ends with the group.
	shell.stdio[3]?.on("error", () => undefined);
	let told: NodeJS.Signals | undefined;
	// A terminal's Ctrl-C, heard but not passed: the group had it.
	let interrupted = false;
	let grace: NodeJS.Timeout | undefined;
	const signal = (sent: NodeJS.Signals) => {
		if (shell.pid === undefined) return;
		try {
			process.kill(fromTerminal ? shell.pid : -shell.pid, sent);
		} catch {
			// The group ended before the signal: nothing is left to end.
		}
	};
	const passOn = (sent: NodeJS.Signals) => {
		if (shell.exitCode !== null || shell.signalCode !== null) return;
		// From a terminal, Ctrl-C reached the shell's group already.
		if (fromTerminal && sent === "SIGINT") {
			interrupted = true;
			return;
		}
		told ??= sent;
		signal(sent);
		grace ??= setTimeout(() => signal("SIGKILL"), GRACE_MS);
	};
	for (const sent of ENDING) process.on(sent, passOn);
	const stopPassing = () => {
		for (const sent of ENDING) process.off(sent, passOn);
		clearTimeout(grace);
	};
	return new Promise((done) => {
		shell.once("error", (error) => {
			stopPassing();
			done({ error: error.message });
		});
		shell.once("exit", (code, by) => {
			stopPassing();
			// What the command left running ends by the watcher, once
			// pi-fence has gone.
			if (told && by) return done({ signal: told });
			// So a calling script stops on Ctrl-C, as it would without us.
			if (interrupted && by === "SIGINT") return done({ signal: by });
			const number = by ? constants.signals[by] : undefined;
			done({
				code: number === undefined ? (code ?? UNKNOWN_END) : SIGNALLED + number,
			});
		});
	});
}

/**
 * End this process as a fenced command's shell ended: with its status,
 * by the caller's signal that ended it, or saying why it never started.
 */
export function endAs(end: ChildEnd): never {
	if ("error" in end) {
		process.stderr.write(`pi-fence: bash didn't start: ${end.error}\n`);
		return process.exit(UNKNOWN_END);
	}
	if ("code" in end) return process.exit(end.code);
	// With no listener left, the signal ends this process as it would have.
	process.kill(process.pid, end.signal);
	return process.exit(SIGNALLED + constants.signals[end.signal]);
}

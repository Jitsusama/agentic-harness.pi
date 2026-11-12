/**
 * The agent's command, kept off its shell's command line.
 *
 * pi runs each command as `bash -c <command>`, so the shell's command line
 * holds the whole command, and `pkill -f` or `pgrep -f` with any pattern
 * from the command matches the shell running it. `pkill -f server.py`
 * killed its own shell before the line after it ran: 71 bash calls
 * across every session between 10 and 22 October ended with exit 143
 * after a `pkill -f`, and `pgrep -f` counted the shell among what it
 * found, so "is it still running" was always yes. The same patterns
 * matched every other session's shell that held them too.
 *
 * Telling agents to kill by PID was the old answer, and it was relearned
 * session after session. The match is the fault, so the match goes: the
 * command travels in an environment variable, which `-f` never reads, and
 * the shell's command line holds only a fixed stub that evaluates it.
 * The stub unsets the variable before the command runs, so nothing the
 * command starts inherits a copy, and keeps it on the same line, so a
 * failing command's line numbers are what they were.
 *
 * What it changes otherwise, measured against `-c` on bash 5: a syntax
 * error is reported as `bash: eval: line N` rather than `bash: -c: line
 * N`, and `ps` shows the stub where it showed the command, though every
 * program the command starts still shows its own. Exit codes, `set -e`,
 * here-documents, `$0` and `exit` behave as they did.
 */

import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

/** The variable the command travels in. */
export const COMMAND_VARIABLE = "PI_BASH_COMMAND";

/** What the shell's command line holds instead of the command. */
export const COMMAND_STUB = `eval "unset ${COMMAND_VARIABLE}; $${COMMAND_VARIABLE}"`;

/** The variable a kept call's path travels in (lib/internal/shell/kept.ts). */
export const KEEP_VARIABLE = "PI_BASH_KEEP";

/**
 * The stub of a call that keeps itself on disk, so another process can
 * say how it ended once pi has gone. It writes its shell's pid first,
 * runs the command in a subshell, so the command's own `exit` and traps
 * can't skip what follows, and sends its output through `tee -p`, which
 * pi reads as before and which writes on to the file when pi's pipe
 * closes. Then it writes the command's status and exits with it. Still
 * one line, so a failing command's line numbers are what they were.
 */
export const KEEPING_STUB = [
	`printf '%s\\n' "$$" > "$${KEEP_VARIABLE}.pid"`,
	`( eval "unset ${COMMAND_VARIABLE} ${KEEP_VARIABLE}; $${COMMAND_VARIABLE}" ) > >(trap '' PIPE; exec tee -p -a "$${KEEP_VARIABLE}.out") 2>&1`,
	"s=$?",
	"wait $! 2>/dev/null",
	`printf '%s\\n' "$s" > "$${KEEP_VARIABLE}.end"`,
	"exit $s",
].join("; ");

/** A spawn hook that moves the command off the shell's command line. */
export function offCommandLine(context: BashSpawnContext): BashSpawnContext {
	return {
		...context,
		command: COMMAND_STUB,
		env: { ...context.env, [COMMAND_VARIABLE]: context.command },
	};
}

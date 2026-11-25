/**
 * The library's exec seam, with heavy work put through the machine's queue.
 *
 * The bash tool's commands wait their turn in the queue (turn.ts), but a
 * tool that runs git itself, as the work tool's push and fetch do, went
 * straight to it. A push of World then held no walk's slot, ran outside
 * the shared slice and kept its LFS scan: of the 16 pushes of World the
 * work tool made from 5 November to the morning of the 6th, 9 were
 * stopped by its ten-minute clock, while the queue's pushes that
 * morning took a median of 29 s.
 *
 * So each command is read as the bash tool's would be. One the queue
 * takes runs as the queued shell it answers, with a clock of its own;
 * any other runs as it was.
 */

import { readFileSync } from "node:fs";
import type { Exec, Turn } from "../../core/exec/index.ts";
import { behindThrough } from "../../core/work/fetch-rules.ts";
import type { Held } from "../sandbox/tree-git.ts";
import { queuedCommand } from "./turn.ts";

/**
 * How long a command the queue took may run, its wait included.
 *
 * Five hours: from the afternoon of 5 November on, the longest wait for a walk's turn was
 * 149 minutes and the longest push 97, so a clock of ten minutes stopped
 * honest work, and one that counts the wait must outlast both.
 */
export const QUEUED_LIMIT_MS = 5 * 60 * 60 * 1000;

/**
 * How World's push gate, a pre-push hook taking pushes of World one at a
 * time, says a push waits for another and that its turn came or it goes
 * on without one, as its git passes on. The gate gives up waiting after
 * 30 minutes; the longest the waits hold the clock leaves it 5 more.
 *
 * The work tool's push runs on a clock of ten minutes, the queue's on
 * five hours, and on 20 November five pushes waited at the gate behind
 * one that hung for 25, so they timed out before their turn came
 * (IKQ63G [d73f883a]). Here rather than beside the work tool, because
 * this module already says how long a push of World may take.
 *
 * The words are the gate's own, read from its program: each line it says
 * starts with its name, so the wait's mark does too, and since a wait is
 * heard only at a line's start, a remote's `remote: ` line stops no
 * clock. The marks that start it again may be looser, since hearing one
 * early only counts more of the wait. A gate that changes its words
 * stops holding the clock, and its pushes end at ten minutes again: the
 * tests pin these words, not the gate's.
 */
export const WORLD_PUSH_TURN: Turn = {
	waits:
		"world-push-gate: another push to World is running; this one waits its turn",
	goes: ["its turn came after", "this one goes on", "this push goes on"],
	longestMs: 35 * 60 * 1000,
};

/**
 * What a git held in a folder with no git at or above it runs behind
 * once the queue takes it: a look at that folder again as its turn
 * comes, and git kept from finding a repository above it, since a
 * command can put a `.git` there while it waits (`unrooted-git.sh`).
 */
const UNROOTED_GIT = readFileSync(
	new URL("./unrooted-git.sh", import.meta.url),
	"utf8",
);

/** The name the unrooted guard's shell runs as, which its refusals don't say. */
const UNROOTED_NAME = "pi-unrooted-git";

/** A word the shell reads as it stands. */
const PLAIN = /^[\w@%+=:,./-]+$/;

/** `word` as one shell word, quoted only when it has to be. */
function shellWord(word: string): string {
	return PLAIN.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * An exec that runs heavy work through the machine's queue: a command
 * the queue takes runs as `bash -c` of its queued shell through
 * `queued`, and every other through `direct`, as it was.
 *
 * `held` says how each command may run, or answers it instead, before
 * either: the queue's shell runs it as held, since an exec behind the
 * queue sees only `bash`, while the queue reads it as it was given, so
 * a job is named and weighed by what was asked rather than by the
 * longer line a guard makes of it.
 *
 * `through` is shell text each command runs behind, given the command
 * and its words as `"$@"`, as a fetch of World runs behind its turn
 * (`fetch-rules.ts`): after the guard, so the guard reads git and not
 * the shell, and inside the queue's shell, so the queue weighs what
 * was asked.
 *
 * A git `held` found no git for runs, once the queue takes it, in the
 * folder the guard read, behind a look at it again as its turn comes
 * (`UNROOTED_GIT`); one that runs at once runs as it was, since it
 * starts as it was read.
 */
export function queuedExec(
	direct: Exec,
	queued: Exec = direct,
	held: (command: string, args: readonly string[]) => Held = (_, args) => ({
		args,
	}),
	through?: string,
): Exec {
	return (command, args) => {
		const hold = held(command, args);
		if ("refused" in hold) return Promise.resolve(hold.refused);
		const line = shellLine(command, args);
		const [program, words] = behind(through, command, hold.args);
		const run =
			hold.unrooted === undefined
				? shellLine(program, words)
				: shellLine(
						...behind(through, "bash", [
							"-c",
							UNROOTED_GIT,
							UNROOTED_NAME,
							hold.unrooted.folder,
							command,
							...hold.unrooted.args,
						]),
					);
		const shell = queuedCommand(line, undefined, () => run);
		return shell === run
			? direct(program, words)
			: queued("bash", ["-c", shell]);
	};
}

/** `command` and `args` as they run behind `through`, when there is one. */
function behind(
	through: string | undefined,
	command: string,
	args: readonly string[],
): [string, string[]] {
	return through === undefined
		? [command, [...args]]
		: ["bash", behindThrough(through, command, args)];
}

/** `command` and `args` as one shell line. */
function shellLine(command: string, args: readonly string[]): string {
	return [command, ...args].map(shellWord).join(" ");
}

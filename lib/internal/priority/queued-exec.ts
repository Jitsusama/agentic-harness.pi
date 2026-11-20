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

import type { Exec, Turn } from "../../core/exec/index.ts";
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
 */
export function queuedExec(direct: Exec, queued: Exec = direct): Exec {
	return (command, args) => {
		const line = [command, ...args].map(shellWord).join(" ");
		const shell = queuedCommand(line);
		return shell === line
			? direct(command, args)
			: queued("bash", ["-c", shell]);
	};
}

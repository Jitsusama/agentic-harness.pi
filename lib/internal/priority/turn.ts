/**
 * A bash call's heavy work waits for its turn in the machine's queue.
 *
 * When the command the agent runs is heavy work (see queue.ts for the
 * one map), its job is put in the queue as the shell is spawned, and the
 * shell runs a few lines first that wait for the job's turn: pi carries
 * on, and only the shell waits. Given its turn, the shell moves into the
 * cgroup the turn names, the timed one for timed work, and says how long
 * it waited when that was long enough to notice.
 *
 * The wait gives way rather than hold work forever: when the job is
 * given up, or nobody has kept the queue for two minutes, the shell
 * runs its command as though there were no queue.
 */

import { randomBytes } from "node:crypto";
import { type QueueFolder, UNKEPT_MS } from "./folder.ts";
import { type Job, kindOf, whatOf } from "./queue.ts";
import type { Reading } from "./room.ts";

/** What a session's queue is kept with, set while the session runs. */
export interface Queueing {
	readonly folder: QueueFolder;
	readonly session: string;
	readonly pid: number;
	readonly room: () => Reading;
	readonly cgroupFor: (job: Job) => string | undefined;
	readonly now?: () => number;
}

/** Seconds a wait lasts before the shell says it waited. */
export const SAID_AFTER_S = 5;

const QUEUEING = Symbol.for("agentic-harness.priority.queueing");

type Holder = { [QUEUEING]?: Queueing };

/** Puts heavy work through the queue from now on; the answer undoes it. */
export function queueHeavyWork(queueing: Queueing): () => void {
	const holder = globalThis as Holder;
	holder[QUEUEING] = queueing;
	return () => {
		if (holder[QUEUEING] === queueing) delete holder[QUEUEING];
	};
}

/**
 * `command`, waiting first for its turn when it is heavy work and a
 * queue is kept here. As it was when it is not, or the queue can't take
 * the job.
 */
export function queuedCommand(command: string): string {
	const queueing = (globalThis as Holder)[QUEUEING];
	const kind = queueing ? kindOf(command) : undefined;
	if (!queueing || !kind) return command;
	const wait = waitsForTurn(queueing.folder.dir);
	if (!wait) return command;
	const now = queueing.now?.() ?? Date.now();
	const job: Job = {
		id: `${now.toString(36)}-${randomBytes(4).toString("hex")}`,
		kind,
		what: whatOf(command),
		owner: { session: queueing.session, pid: queueing.pid },
		since: new Date(now).toISOString(),
	};
	try {
		queueing.folder.ask(job);
		queueing.folder.keep(queueing.room(), now, queueing.cgroupFor);
	} catch {
		// A queue that can't be written to holds nobody's work back.
		return command;
	}
	return `${wait(job.id)}\n${command}`;
}

/**
 * The lines a shell runs to wait for job `id`'s turn in the queue kept
 * at `dir`, or nothing for a folder that can't be quoted plainly. They
 * leave no variable behind and `$?` at 0.
 */
export function waitsForTurn(
	dir: string,
	saidAfterS: number = SAID_AFTER_S,
): ((id: string) => string) | undefined {
	if (dir.includes("'")) return undefined;
	return (id) =>
		[
			`__queue='${dir}' __job='${id}' __since=$SECONDS`,
			`printf '%s\\n' "$$" 2>/dev/null > "$__queue/$__job.pid"`,
			`while [ ! -e "$__queue/$__job.turn" ] && [ -e "$__queue/$__job.job" ] && [ $(( $(date +%s) - $(stat -c %Y "$__queue/queue.json" 2>/dev/null || echo 0) )) -lt ${UNKEPT_MS / 1000} ]; do sleep 1; done`,
			`__into=$(cat "$__queue/$__job.turn" 2>/dev/null)`,
			`[ -n "$__into" ] && { printf '%s\\n' "$$" 2>/dev/null > "$__into/cgroup.procs" || :; }`,
			`__since=$(( SECONDS - __since ))`,
			`[ "$__since" -ge ${saidAfterS} ] && printf 'Waited %ss for its turn in the machine queue.\\n' "$__since" >&2`,
			"unset __queue __job __since __into; :",
		].join("\n");
}

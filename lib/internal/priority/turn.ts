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
 * When the work has run for a minute or more, its shell says as it ends
 * what room the machine had left beside it, and that independent work
 * can run at once. The queue can't start work nobody asked for, and
 * an agent that waits out one long build or test after another leaves
 * the rest of the machine idle: the result is where an agent learns
 * that, at the moment it would start the next one. Said on exit, so it
 * stays with the end of the output that a long result keeps; a command
 * that sets its own exit trap replaces it, and its exit code is kept.
 *
 * The wait gives way rather than hold work forever: when the job is
 * given up, or nobody has kept the queue for two minutes, the shell
 * runs its command as though there were no queue.
 */

import { randomBytes } from "node:crypto";
import { type QueueFolder, UNKEPT_MS } from "./folder.ts";
import {
	type Job,
	kindOf,
	NEEDS_GIB,
	needsGibOfCommand,
	whatOf,
} from "./queue.ts";
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

/**
 * The line a shell given its turn beside a VM check runs: its Nix builds
 * read `capped.conf` first, then the files Nix would read anyway, so the
 * person's own nix.conf still holds and only the cap overrides it. A
 * setting file rather than flags, since the work is often a `nix build`
 * inside a loop or a script no flag reaches; an inline `NIX_CONFIG`
 * with access tokens leaves it, as one naming max-jobs would not. Said
 * in the output, so a VM check failing beside it can be traced to it.
 * The settings themselves are the queue's, read from the job's own
 * `.capped`, since a quick job is held tighter than a build and a VM
 * failing beside a capped build lowers them; a `.capped` left empty, as
 * a session on an older harness writes it, means `capped.conf`.
 *
 * cargo is held to the same cores, through `CARGO_BUILD_JOBS`: the cap
 * reached only Nix, so a cargo build given its turn beside a VM check
 * still ran a rustc for every core. A `-j` on the command still wins,
 * as cargo lets it.
 */
const CAPPING = [
	'[ -e "$__queue/$__job.capped" ] && {',
	' __cap="$__queue/$__job.capped"; [ -s "$__cap" ] || __cap="$__queue/capped.conf";',
	` export NIX_USER_CONF_FILES="$__cap:\${NIX_USER_CONF_FILES:-\${XDG_CONFIG_HOME:-$HOME/.config}/nix/nix.conf:$(printf '%s' "\${XDG_CONFIG_DIRS:-/etc/xdg}" | sed 's#:#/nix/nix.conf:#g; s#$#/nix/nix.conf#')}";`,
	` __cores=$(sed -n 's/^cores = //p' "$__cap"); [ -n "$__cores" ] && export CARGO_BUILD_JOBS="$__cores";`,
	` printf 'Runs beside a VM check, so its Nix builds are held to %s at once, of %s cores each, and cargo to %s jobs.\\n' "$(sed -n 's/^max-jobs = //p' "$__cap")" "$__cores" "$__cores" >&2; unset __cores __cap; }`,
].join("");

/** Seconds a wait lasts before the shell says it waited. */
export const SAID_AFTER_S = 5;

/** Seconds work runs before its shell says the room left as it ends. */
export const ROOM_SAID_AFTER_S = 60;

/**
 * Seconds between two looks of a waiting shell, a second apart, that
 * mean the machine slept between them. A loaded machine can stall a
 * shell for a few seconds, which costs only a grace nobody needs.
 */
const JUMP_S = 5;

/**
 * Seconds a waiting shell gives the queue's keepers to write queue.json
 * once it has seen the clock jump. They keep it every two seconds.
 */
const GRACE_S = 10;

/**
 * What the shell says of the room left; `%s` is the room, as words. It
 * sits in single quotes in the shell, so it holds none.
 */
export const ROOM_SAID =
	"The machine has room for %s right now. Builds and tests independent of each other can run at once, each as its own bash call with background: true, and each takes its own turn.";

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
	const read = queueing ? kindOf(command) : undefined;
	if (!queueing || !read) return command;
	const wait = waitsForTurn(queueing.folder.dir);
	if (!wait) return command;
	const now = queueing.now?.() ?? Date.now();
	const what = whatOf(command);
	const kind = queueing.folder.kindFor(read, what);
	const needsGib = needsGibOfCommand(kind, command);
	// A step past the one named that needs more, as changed-checks after a
	// check's build does, is no seconds-long job, whatever the first is.
	const quick =
		needsGib <= NEEDS_GIB[kind] && queueing.folder.quickFor(kind, what);
	const job: Job = {
		id: `${now.toString(36)}-${randomBytes(4).toString("hex")}`,
		kind,
		what,
		needsGib,
		...(quick ? { quick: true as const } : {}),
		owner: { session: queueing.session, pid: queueing.pid },
		since: new Date(now).toISOString(),
		cappable: true,
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
	roomSaidAfterS: number = ROOM_SAID_AFTER_S,
): ((id: string) => string) | undefined {
	if (dir.includes("'")) return undefined;
	return (id) =>
		[
			`__queue='${dir}' __job='${id}' __since=$SECONDS`,
			`printf '%s\\n' "$$" 2>/dev/null > "$__queue/$__job.pid"`,
			// It waits while nobody has given up its job and somebody keeps the
			// queue, by queue.json's age. Nobody writes that while the machine
			// sleeps, so a clock that jumped gives the keepers a grace to
			// wake and write it before its age counts.
			`__then=$(date +%s) __grace=0`,
			`while [ ! -e "$__queue/$__job.turn" ] && [ -e "$__queue/$__job.job" ] && { __now=$(date +%s); [ $(( __now - __then )) -gt ${JUMP_S} ] && __grace=$(( __now + ${GRACE_S} )); __then=$__now; [ $(( __now - $(stat -c %Y "$__queue/queue.json" 2>/dev/null || echo 0) )) -lt ${UNKEPT_MS / 1000} ] || [ "$__now" -lt "$__grace" ]; }; do sleep 1; done`,
			// The mark its time limit starts from (clock.ts): the run begins
			// here, whether its turn was given or the wait gave way.
			`{ : > "$__queue/$__job.began"; } 2>/dev/null || :`,
			`__into=$(cat "$__queue/$__job.turn" 2>/dev/null)`,
			`[ -n "$__into" ] && { printf '%s\\n' "$$" 2>/dev/null > "$__into/cgroup.procs" || :; }`,
			CAPPING,
			`__since=$(( SECONDS - __since ))`,
			`[ "$__since" -ge ${saidAfterS} ] && printf 'Waited %ss for its turn in the machine queue.\\n' "$__since" >&2`,
			"__ran=$SECONDS",
			`trap "__end=\\$?; printf '%s\\\\n' \\"\\$__end\\" 2>/dev/null > '${dir}/${id}.end'; __room=\\$(cat '${dir}/room' 2>/dev/null); [ \\$(( SECONDS - $__ran )) -ge ${roomSaidAfterS} ] && [ -n \\"\\$__room\\" ] && printf '${ROOM_SAID}\\\\n' \\"\\$__room\\" >&2" EXIT`,
			"unset __queue __job __since __into __ran __then __now __grace; :",
		].join("\n");
}

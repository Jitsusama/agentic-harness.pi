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
import { homedir } from "node:os";
import { hosted, sessionCell } from "../../core/session/index.ts";
import { offeredShellEnvironment } from "../shell/environment.ts";
import { FETCHED_FOLDER, readsMain, worldGit } from "./fetched.ts";
import { type QueueFolder, UNKEPT_MS } from "./folder.ts";
import { planFor, planLines } from "./plan.ts";
import { placePushHooks, pushesLine } from "./pushes.ts";
import {
	CHANGED_CHECKS_SENT_GIB,
	type Job,
	kindOf,
	leastGibOfCommand,
	NEEDS_GIB,
	needsGibOfCommand,
	PUSH_GIB,
	walkOf,
	whatOf,
} from "./queue.ts";
import type { Reading } from "./room.ts";
import { inSharedSlice } from "./shared-slice.ts";

/** What a session's queue is kept with, set while the session runs. */
export interface Queueing {
	readonly folder: QueueFolder;
	readonly session: string;
	readonly room: () => Reading;
	readonly cgroupFor: (job: Job) => string | undefined;
	readonly now?: () => number;
	/**
	 * Whether a command run from a folder is a changed-checks run that
	 * sends itself to the builder (send.ts's `sendsWholeRun`).
	 */
	readonly sendsWholeRun?: (command: string, cwd: string) => boolean;
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

/**
 * The variable that names the quest a command's work is for, as
 * quest-workflow offers it to every command (its `QUEST_ENV`).
 */
const QUEST_VARIABLE = "PI_QUEST";

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

/**
 * Where a session's queue is kept with: one per process on plain pi, one
 * per conversation on a host, so each conversation's work is its own and
 * one conversation ending leaves the others' queueing in place.
 */
const QUEUEING = "agentic-harness.priority.queueing";

/**
 * The process whose end ends a job's claim on the queue: the host on a
 * host, since a conversation's shells are the host's children, and this
 * pi otherwise.
 */
function ownerPid(): number {
	return hosted()?.owner.pid ?? process.pid;
}

/**
 * Puts the session's heavy work through the queue from now on; the
 * answer undoes it. Called within the session, as its start runs.
 */
export function queueHeavyWork(queueing: Queueing): () => void {
	const cell = sessionCell<Queueing>(QUEUEING);
	cell.set(queueing);
	return () => {
		if (cell.get() === queueing) cell.clear();
	};
}

/**
 * `command`, run in `cwd`, waiting first for its turn when it is heavy
 * work and a queue is kept here. As it was when it is not, or the queue
 * can't take the job. Without `cwd`, a walk of World's objects is read
 * only from the folders the command names.
 *
 * `wrap` changes how the command itself runs, as a sandbox does, once its
 * turn has come. The queue reads the command as it was given, so wrapped
 * work is weighed as the same work, and the lines that wait for its turn
 * run outside the wrap, where the queue's folder is.
 */
export function queuedCommand(
	command: string,
	cwd?: string,
	wrap: (run: string) => string = (run) => run,
): string {
	const queueing = sessionCell<Queueing>(QUEUEING).get();
	const where = { ...(cwd ? { cwd } : {}), home: homedir() };
	const read = queueing ? kindOf(command, where) : undefined;
	if (!queueing || !read) return wrap(command);
	const wait = waitsForTurn(queueing.folder.dir);
	if (!wait) return wrap(command);
	const now = queueing.now?.() ?? Date.now();
	const what = whatOf(command);
	const kind = queueing.folder.kindFor(read, what);
	// What it held the last time it ran, when it has run: a guess for its
	// kind only for work never seen. A walk of World's objects is held to
	// its kind's at least: its scope is charged only the pack pages it
	// read in first, and another walk's evicted pages are what it maps.
	// A changed-checks run that sends itself to the builder holds what
	// deciding to send it takes here: what its runs held, once seen, up
	// to what one never seen is held to, since a run the builder turned
	// away ran here whole and says nothing of a send.
	const seen = queueing.folder.peakFor(what);
	const sent =
		kind !== "world-walk" &&
		cwd !== undefined &&
		(queueing.sendsWholeRun?.(command, cwd) ?? false);
	const walk = kind === "world-walk" ? walkOf(command, where) : undefined;
	// A push of World leaves out its LFS scan when it holds no LFS file
	// (pushes.ts); without the hooks placed it runs them as it would.
	const hooks =
		walk === "push" && placePushHooks(queueing.folder.dir)
			? pushesLine(queueing.folder.dir)
			: undefined;
	// A push that leaves out its scan walks no packs, so it is held to
	// what it uses rather than to a walk's (queue.ts's `PUSH_GIB`).
	const walkGib = hooks
		? Math.max(PUSH_GIB, seen ?? 0)
		: Math.max(NEEDS_GIB[kind], seen ?? 0);
	// A step that runs a zone's evaluation tests holds the command to
	// theirs at least, since earlier runs may have stopped short of them.
	const needsGib = Math.max(
		leastGibOfCommand(command),
		kind === "world-walk"
			? walkGib
			: sent
				? Math.min(seen ?? CHANGED_CHECKS_SENT_GIB, CHANGED_CHECKS_SENT_GIB)
				: (seen ?? needsGibOfCommand(kind, command)),
	);
	// A step past the one named that needs more, as changed-checks after a
	// check's build does, is no seconds-long job, whatever the first is.
	const quick =
		hooks !== undefined ||
		(needsGib <= NEEDS_GIB[kind] && queueing.folder.quickFor(kind, what));
	const lastRanS = queueing.folder.ranFor(what);
	const quest = offeredShellEnvironment()[QUEST_VARIABLE];
	// A build of checks is asked what it will build before its turn, since
	// its text can't say whether a VM runs (plan.ts); quick work is cached.
	const plan =
		!quick && (kind === "build" || kind === "vm-check")
			? planFor(command)
			: undefined;
	const job: Job = {
		id: `${now.toString(36)}-${randomBytes(4).toString("hex")}`,
		kind,
		what,
		needsGib,
		...(lastRanS !== undefined ? { lastRanS } : {}),
		...(quick ? { quick: true as const } : {}),
		...(walk ? { walk } : {}),
		...(sent ? { sent: true as const } : {}),
		...(quest ? { quest } : {}),
		...(plan ? { planning: true as const } : {}),
		owner: { session: queueing.session, pid: ownerPid() },
		since: new Date(now).toISOString(),
		cappable: true,
	};
	try {
		queueing.folder.ask(job);
		queueing.folder.keep(queueing.room, now, queueing.cgroupFor);
	} catch {
		// A queue that can't be written to holds nobody's work back.
		return wrap(command);
	}
	const fetches = walk === "main-fetch" ? worldGit() : undefined;
	const waits = wait(job.id, plan ? planLines(plan) : [], fetches);
	// What holds a walk's slot runs where the agents' disk target holds,
	// since every other walk waits on it (shared-slice.ts).
	const run =
		kind === "world-walk" ? inSharedSlice(wrap(command)) : wrap(command);
	return hooks ? `${waits}\n${hooks}\n${run}` : `${waits}\n${run}`;
}

/**
 * The lines a shell runs to wait for job `id`'s turn in the queue kept
 * at `dir`, or nothing for a folder that can't be quoted plainly. They
 * leave no variable behind and `$?` at 0. Given World's repository, the
 * job fetches its main (fetched.ts): answered, the shell puts the
 * queue's `git` first on its PATH; otherwise it reads `origin/main` as
 * its run begins and as it ends, to say whether the fetch moved it.
 */
export function waitsForTurn(
	dir: string,
	saidAfterS: number = SAID_AFTER_S,
	roomSaidAfterS: number = ROOM_SAID_AFTER_S,
):
	| ((id: string, plan?: readonly string[], world?: string) => string)
	| undefined {
	if (dir.includes("'")) return undefined;
	return (id, plan = [], given) => {
		const world = given?.includes("'") ? undefined : given;
		const fetching = world
			? [
					`if [ -e "$__queue/$__job.fetched" ]; then PATH="$__queue/${FETCHED_FOLDER}:$PATH"; else ${readsMain(world, `'${dir}/${id}.main-before'`)}; fi`,
				]
			: [];
		const ended = world
			? `${readsMain(world, `'${dir}/${id}.main-after'`)}; `
			: "";
		return [
			`__queue='${dir}' __job='${id}' __since=$SECONDS`,
			`printf '%s\\n' "$$" 2>/dev/null > "$__queue/$__job.pid"`,
			// What it will build, asked before its place in line is given.
			...plan,
			// It waits while nobody has given up its job and somebody keeps the
			// queue, by queue.json's age. Nobody writes that while the machine
			// sleeps, so a clock that jumped gives the keepers a grace to
			// wake and write it before its age counts.
			"__then=$(date +%s) __grace=0",
			`while [ ! -e "$__queue/$__job.turn" ] && [ -e "$__queue/$__job.job" ] && { __now=$(date +%s); [ $(( __now - __then )) -gt ${JUMP_S} ] && __grace=$(( __now + ${GRACE_S} )); __then=$__now; [ $(( __now - $(stat -c %Y "$__queue/queue.json" 2>/dev/null || echo 0) )) -lt ${UNKEPT_MS / 1000} ] || [ "$__now" -lt "$__grace" ]; }; do sleep 1; done`,
			// The mark its time limit starts from (clock.ts): the run begins
			// here, whether its turn was given or the wait gave way.
			`{ : > "$__queue/$__job.began"; } 2>/dev/null || :`,
			...fetching,
			`__into=$(cat "$__queue/$__job.turn" 2>/dev/null)`,
			`[ -n "$__into" ] && { printf '%s\\n' "$$" 2>/dev/null > "$__into/cgroup.procs" || :; }`,
			CAPPING,
			"__since=$(( SECONDS - __since ))",
			`[ "$__since" -ge ${saidAfterS} ] && printf 'Waited %ss for its turn in the machine queue.\\n' "$__since" >&2`,
			"__ran=$SECONDS",
			`trap "__end=\\$?; ${ended}printf '%s\\\\n' \\"\\$__end\\" 2>/dev/null > '${dir}/${id}.end'; __room=\\$(cat '${dir}/room' 2>/dev/null); [ \\$(( SECONDS - $__ran )) -ge ${roomSaidAfterS} ] && [ -n \\"\\$__room\\" ] && printf '${ROOM_SAID}\\\\n' \\"\\$__room\\" >&2" EXIT`,
			"unset __queue __job __since __into __ran __then __now __grace; :",
		].join("\n");
	};
}

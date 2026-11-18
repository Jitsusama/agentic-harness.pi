/**
 * Sweeping ended sessions' trees, a few minutes after a session starts
 * and every hour after.
 *
 * At a session's start rather than its end, since a session that is
 * killed never runs its end, and any later start sees every owner that
 * has ended since. A few minutes in, so a session's first turns don't
 * share the disk with a removal, and every hour, since a session can run
 * for days. Off the turn, and never waited on: what it did goes to a log
 * beside the trees' records, one JSON line a sweep, naming the trees
 * taken and those whose dev-shell roots were dropped. A sweep that
 * rests, since one ended within the last 20 minutes, writes none.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionSlot, withSession } from "../../lib/core/session/index.ts";
import {
	type SweptTrees,
	type TreeClaims,
	WORK_TREE_CLAIMS,
	WORK_TREES_SWEPT,
} from "../../lib/core/work/events.ts";
import { resolvedPath, type UseSigns } from "../../lib/core/work/in-use.ts";
import { createTreeMemory } from "../../lib/core/work/memory.ts";
import { listTreeProviders } from "../../lib/core/work/register.ts";
import {
	type SweepOutcome,
	sweepEndedTrees,
} from "../../lib/core/work/sweep.ts";
import { machineBooted } from "../../lib/internal/machine/booted.ts";
import { everyRealmsDir, stateDir } from "../../lib/internal/paths.ts";
import { discoverQuests } from "../../lib/internal/quest/discovery/discovery.ts";
import {
	foldersOfSessionsNobodyClosed,
	sessionsNobodyClosed,
} from "../../lib/internal/quest/sessions/loaded.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace/workspace-root.ts";
import { unattendedExec } from "../../lib/internal/sandbox/unattended-exec.ts";
import { rosterFolders } from "../../lib/internal/session/host-holds.ts";
import { treeRecordDir } from "../../lib/internal/work-records.ts";
import { census } from "../../lib/mesh/liveness.ts";
import { createPresences, type Presence } from "../../lib/mesh/presence.ts";

/** How long after a session starts its first sweep runs. */
const FIRST_SWEEP_MS = 3 * 60 * 1000;

/** How often a session sweeps after its first. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * How long the machine rests after any sweep ends, whichever session
 * ran it: each session sweeps hourly on its own timer, so a hundred of
 * them would otherwise keep one sweep or another running all the time.
 */
const SWEEP_REST_MS = 20 * 60 * 1000;

/**
 * How long a session a crash or a signal took away keeps its trees:
 * a day, the time a restore after a reboot or a crash takes to be
 * noticed. A reopen after that finds its folder gone and starts in a
 * fallback one, and the sweep's log line names the branch to recut.
 */
const LOST_HOLDS_FOR_MS = 24 * 60 * 60 * 1000;

/** How many of the commonest reasons for keeping a tree a log line names. */
const KEPT_REASONS_NAMED = 8;

/**
 * One conversation's sweep timers. In a session slot rather than module
 * state, since a host runs several conversations in one process: B's
 * start must not stop A's sweeps, nor B's close leave A sweeping never.
 * On plain pi the slot is one process symbol, as the module's were.
 */
interface Sweeps {
	first?: ReturnType<typeof setTimeout>;
	every?: ReturnType<typeof setInterval>;
}

const SWEEPS = "agentic-harness.work.sweeps.v1";

function sweeps(id: string | undefined): Sweeps {
	return sessionSlot<Sweeps>(SWEEPS, id, () => ({}));
}

/** Sweep a while after each session starts and hourly, until it ends. */
export function registerTreeSweeps(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		const own = sweeps(id);
		stopSweeps(own);
		// A timer fires outside any hook, so each sweep enters its own
		// conversation again: what it runs reads that conversation's state,
		// as the queue does, and a host refuses a call that names none.
		const sweep = () => void withSession(id, () => sweepOnce(pi));
		own.first = setTimeout(sweep, FIRST_SWEEP_MS);
		own.every = setInterval(sweep, SWEEP_EVERY_MS);
		// Neither keeps a pi that is otherwise done from exiting.
		own.first.unref();
		own.every.unref();
	});
	pi.on("session_shutdown", (_event, ctx) =>
		stopSweeps(sweeps(ctx.sessionManager.getSessionId())),
	);
}

function stopSweeps(own: Sweeps): void {
	if (own.first !== undefined) clearTimeout(own.first);
	if (own.every !== undefined) clearInterval(own.every);
	own.first = undefined;
	own.every = undefined;
}

/** One sweep, logged, which never throws into a timer. */
async function sweepOnce(pi: ExtensionAPI): Promise<void> {
	const dir = stateDir("work");
	const started = Date.now();
	let line: Record<string, unknown>;
	let taken: string[] = [];
	try {
		// A quest holds trees the broker knows nothing of, and says so
		// when asked, as it does for reclaim. A live quest's trees are
		// held for good here: offered as held only until spent, one sweep
		// on 11 November took 154 trees, among them the folder a hosted
		// conversation worked in, since nothing here sees a hosted
		// conversation's folder as in use.
		// Asked only by a sweep that runs, as the sweep says why.
		const claimed = (): readonly string[] => {
			const claims: TreeClaims = { paths: [] };
			pi.events.emit(WORK_TREE_CLAIMS, claims);
			return claims.paths;
		};
		const outcome = await sweepEndedTrees({
			exec: unattendedExec(),
			memory: createTreeMemory(treeRecordDir()),
			claims: claimed,
			lockPath: join(dir, "sweep.lock"),
			restMs: SWEEP_REST_MS,
			wentWithFinishedWork: inFinishedQuest,
			providers: listTreeProviders,
			...useSigns(),
		});
		// A sweep that rested did nothing, and the one before it said what
		// it did: a line for each filled the log at one every 3 seconds on
		// 18 November. One that found another running still says so, as
		// the only sign of a sweep that holds the lock and never ends.
		if (outcome.rested !== undefined) return;
		line = said(outcome);
		taken = outcome.taken.map((tree) => tree.path);
	} catch (error) {
		line = { failed: error instanceof Error ? error.message : String(error) };
	}
	logSweep({ ms: Date.now() - started, ...line }, started);
	// Whoever listed a tree it took stops listing a folder that is gone.
	// pi's bus reports a listener's error itself, never to the emitter.
	if (taken.length > 0) {
		const swept: SweptTrees = { paths: taken };
		pi.events.emit(WORK_TREES_SWEPT, swept);
	}
}

/**
 * Write one line to the sweep's log, dated `at`, in milliseconds since
 * the epoch: a sweep's outcome, or a tree a sweep took being cut afresh.
 */
export function logSweep(line: Record<string, unknown>, at = Date.now()): void {
	const dir = stateDir("work");
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "sweep.log"),
			`${JSON.stringify({ at: new Date(at).toISOString(), pid: process.pid, ...line })}\n`,
		);
	} catch {
		// The log is for reading afterwards; a sweep that can't write it
		// has still done what it did, and a timer has nobody to tell.
	}
}

/** The statuses a quest has once its work is done. */
const FINISHED = new Set(["concluded", "retired"]);

/**
 * Whether a git folder lay in the scratch folder of a quest that has
 * concluded or retired. Conclude takes the whole scratch folder, and a
 * clone in it goes too, leaving the trees cut from it with nothing.
 */
function inFinishedQuest(gitDir: string): boolean {
	const within = relative(questWorkspacesRoot(), gitDir);
	if (within.startsWith("..") || isAbsolute(within)) return false;
	const id = within.split(sep)[0] ?? "";
	// Scratch folders are the machine's, and their quest may be any realm's.
	for (const dir of everyRealmsDir("data", "quest-workflow")) {
		const { index } = discoverQuests(join(dir, "quests"));
		const status = index.quests.get(id)?.doc.frontMatter.status;
		if (status !== undefined) return FINISHED.has(status);
	}
	return false;
}

/**
 * What tells a tree is in use on this machine beyond its record's
 * owners, for whatever takes trees whose owners have ended.
 */
export function useSigns(): UseSigns {
	// One census for both signs, since each asks every presence again,
	// and one reading of every process's folder for the sweep.
	let present: Promise<readonly Presence[]> | undefined;
	let standing: Promise<string[]> | undefined;
	const onTheMesh = () => {
		present ??= presentNow();
		return present;
	};
	return {
		liveSessions: () => liveSessions(onTheMesh),
		sessionFolders: () => sessionFolders(onTheMesh),
		standingIn: () => {
			standing ??= standingIn();
			return standing;
		},
		busyAmong,
		...bootedAt(),
	};
}

/** The sessions on the mesh now, in every realm: trees are the machine's. */
async function presentNow(): Promise<readonly Presence[]> {
	const everyone = everyRealmsDir("state", "mesh-workflow").flatMap((dir) =>
		createPresences(join(dir, "presence")).all(),
	);
	return (await census(everyone)).present;
}

/**
 * The folders live sessions work in, wherever they run: those on the
 * mesh now, those nobody closed or that are parked, and those a host
 * keeps for its resume, whose folder is no process's working folder.
 */
async function sessionFolders(
	onTheMesh: () => Promise<readonly Presence[]>,
): Promise<string[]> {
	const [present, recorded] = await Promise.all([
		onTheMesh(),
		Promise.all(
			everyRealmsDir("state", "quest-workflow").map((dir) =>
				foldersOfSessionsNobodyClosed(
					join(dir, "sessions"),
					Date.now() - LOST_HOLDS_FOR_MS,
				),
			),
		),
	]);
	return [
		...present.flatMap((one) => (one.cwd === undefined ? [] : [one.cwd])),
		...recorded.flat(),
		...everyRealmsDir("state", "host-rosters").flatMap((dir) =>
			rosterFolders(dir),
		),
	];
}

/**
 * The sessions that still hold their trees, by session id: those on
 * the mesh now, and those nobody closed, which restore brings back.
 */
async function liveSessions(
	onTheMesh: () => Promise<readonly Presence[]>,
): Promise<ReadonlySet<string>> {
	const [present, unclosed] = await Promise.all([
		onTheMesh(),
		// A session the machine's shutdown or a closed window took away is
		// one restore brings back, and it comes back to the trees it had.
		Promise.all(
			everyRealmsDir("state", "quest-workflow").map((dir) =>
				sessionsNobodyClosed(
					join(dir, "sessions"),
					Date.now() - LOST_HOLDS_FOR_MS,
				),
			),
		),
	]);
	return new Set([
		...present.map((one) => one.session),
		...unclosed.flatMap((ids) => [...ids]),
	]);
}

/**
 * The working folder of every process the kernel lists, which on a
 * machine without `/proc` is none. Each is read off the event loop,
 * which reading a thousand at once in one step held for 469 ms in a
 * shared host (OSPHT4, 14 November 2026).
 */
async function standingIn(): Promise<string[]> {
	let pids: string[];
	try {
		pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
	} catch {
		// No /proc, as on macOS: the other guards still stand.
		return [];
	}
	const folders = await Promise.all(
		pids.map((pid) =>
			readlink(join("/proc", pid, "cwd")).catch(
				// Ended since the listing, or another user's: nothing to read.
				() => undefined,
			),
		),
	);
	return folders.filter((folder) => folder !== undefined);
}

/**
 * How many processes' links are read at once. Each read waits its turn
 * on libuv's few threads, which a shared host's other conversations need
 * too, and a machine's processes hold tens of thousands of descriptors.
 */
const PROCESSES_AT_ONCE = 64;

/**
 * The link the kernel gives the machine's own process namespace, which
 * it numbers the same on every boot.
 */
const HOST_PID_NAMESPACE = "pid:[4026531836]";

/**
 * Which of `paths` a process running now works in or holds a file open
 * in, or a live session's folder lies in, read afresh from the kernel's
 * links and the sessions' records. Nothing when there is no `/proc`, as
 * on macOS, or when this process sees only a namespace's share of it, as
 * in a container, so a tree a session still open holds is never taken
 * there.
 */
async function busyAmong(
	paths: readonly string[],
): Promise<ReadonlySet<string> | undefined> {
	let pids: string[];
	try {
		if ((await readlink("/proc/self/ns/pid")) !== HOST_PID_NAMESPACE)
			return undefined;
		pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
	} catch {
		return undefined;
	}
	const asked = new Set(paths);
	const busy = new Set<string>();
	// Up a link's folders rather than across every path, since a sweep
	// asks of hundreds of trees and a machine holds tens of thousands.
	const mark = (link: string) => {
		for (let at = link; at.startsWith("/"); at = dirname(at)) {
			if (asked.has(at)) busy.add(at);
			if (at === "/") break;
		}
	};
	let next = 0;
	const reader = async () => {
		while (next < pids.length && busy.size < asked.size) {
			const proc = join("/proc", pids[next++] ?? "");
			// Ended since the listing, or another user's: nothing to read.
			mark(await readlink(join(proc, "cwd")).catch(() => ""));
			const fds = join(proc, "fd");
			for (const fd of await readdir(fds).catch((): string[] => [])) {
				mark(await readlink(join(fds, fd)).catch(() => ""));
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(PROCESSES_AT_ONCE, pids.length) }, reader),
	);
	// A session's folder may name a link; the kernel's are real paths.
	for (const folder of await sessionFolders(presentNow)) {
		mark(resolvedPath(folder));
	}
	return busy;
}

/** When this boot began, where the machine will say. */
function bootedAt(): { bootedAt?: number } {
	const at = machineBooted();
	return at === undefined ? {} : { bootedAt: at };
}

/** A sweep's outcome as its log line holds it. */
function said(outcome: SweepOutcome): Record<string, unknown> {
	if (outcome.skipped !== undefined) return { skipped: outcome.skipped };
	return {
		taken: outcome.taken,
		refused: outcome.refused,
		kept: outcome.kept.length,
		keptFor: commonest(outcome.kept.map((one) => one.why)),
		dropped: outcome.dropped,
	};
}

/**
 * The commonest reasons trees were kept, with how many each, so a log
 * line says what stands between the disk and its trees without naming
 * five hundred of them.
 */
function commonest(whys: readonly string[]): Record<string, number> {
	const counts = new Map<string, number>();
	for (const said of whys) {
		// The one reason that names its tree's branch, counted as one reason.
		const why = said.replace(
			/^(nothing holds it, but )\S+( is not contained in trunk)/,
			"$1its branch$2",
		);
		counts.set(why, (counts.get(why) ?? 0) + 1);
	}
	return Object.fromEntries(
		[...counts].sort(([, a], [, b]) => b - a).slice(0, KEPT_REASONS_NAMED),
	);
}

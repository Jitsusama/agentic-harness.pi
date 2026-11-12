/**
 * Priority Workflow Extension
 *
 * Keeps pi ahead of the work it starts, and the machine's heavy work
 * taking turns by the room it needs.
 *
 * pi is something a person works in, and a build, a test run or a
 * subagent it starts should never make it, or anything else the person
 * is using, slow to answer. Where the machine keeps an idle cgroup for
 * work and names it in `JOBS_CGROUP`, every process pi spawns is written
 * into it as it is spawned; pi stays where it was started. A setting
 * that names a cgroup that isn't there is said once.
 *
 * Heavy work goes through the machine's queue, shared by every pi
 * session in `$XDG_RUNTIME_DIR/jobs`: a bash call running a build, a VM
 * test or a benchmark waits in its shell for its turn, and timed work
 * then runs in the cgroup `TIMED_CGROUP` names, or in jobs while there
 * is none. Every session keeps the queue a little at a time, so it goes
 * on while any session runs. A Mac keeps the same queue, in its
 * account's temporary folder, by its own room reading
 * (lib/internal/priority/room-darwin.ts), and places nothing, since it
 * has no cgroups. Elsewhere, nothing changes.
 *
 * The machine's room and the builds' yield are read and set off pi's
 * main thread, so a cgroup file, a process's memory or systemd taking
 * its time never holds the keys the person types. A turn asked for
 * between keeps is given by the room as read just before its command.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import {
	backgroundDir,
	backgroundTurns,
} from "../../lib/internal/priority/background.ts";
import {
	machineQueueDir,
	questsFirstIn,
	queueFolder,
} from "../../lib/internal/priority/folder.ts";
import { jobsProcs, placeChildren } from "../../lib/internal/priority/place.ts";
import { skippedHooksRefusal } from "../../lib/internal/priority/pushes.ts";
import {
	CLASS_OF,
	type Job,
	kindOf,
	type Rules,
	runsChangedChecks,
} from "../../lib/internal/priority/queue.ts";
import { claimReading } from "../../lib/internal/priority/reading-claim.ts";
import {
	cgroupOf,
	commandsIn,
	floorsIn,
	isRunning,
	KERNEL,
	ownedMemoryPeakOf,
	type Reading,
	readRoom,
} from "../../lib/internal/priority/room.ts";
import { darwinRoom } from "../../lib/internal/priority/room-darwin.ts";
import {
	sendsWholeRun,
	takesKnown,
	takesNow,
} from "../../lib/internal/priority/send.ts";
import { queueHeavyWork } from "../../lib/internal/priority/turn.ts";
import { typedDir, typedTurns } from "../../lib/internal/priority/typed.ts";
import {
	buildsShouldYield,
	keepYield,
	systemBuildSlice,
} from "../../lib/internal/priority/yield.ts";
import { meansPresence } from "../../lib/ui/terminal-reports.ts";

/**
 * Refuse a push of World that skips dev's pre-push hooks, on any
 * platform, since the queue's own push hooks already spare a push that
 * holds no LFS file its scan.
 */
export function refuseSkippedPushHooks(pi: Pick<ExtensionAPI, "on">): void {
	declareGuards(GUARDS.worldPushHooks);
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const reason = skippedHooksRefusal(event.input.command, {
			cwd: ctx.cwd,
			home: homedir(),
		});
		return refusalUnder(
			GUARDS.worldPushHooks.name,
			reason ? { block: true, reason } : undefined,
			"World push without its hooks",
		);
	});
}

/** How often a session keeps the queue. */
const KEEP_MS = 2_000;

/** How often the memory floors are looked for again. */
const FLOORS_MS = 5 * 60_000;

/**
 * How young the room's last reading must be to give a turn asked for
 * between keeps: it is read just before a heavy command, milliseconds
 * ahead of the ask.
 */
const RECENT_ROOM_MS = 5_000;

function ownCgroup(): string | undefined {
	try {
		return readFileSync("/proc/self/cgroup", "utf8");
	} catch {
		return undefined;
	}
}

export default function priorityWorkflow(pi: ExtensionAPI) {
	refuseSkippedPushHooks(pi);
	if (process.platform === "darwin") {
		// A Mac takes turns too, with its own room reading and no cgroups:
		// a session there already runs at Utility QoS from its launchd job,
		// so its work needs no placing (G9, 20KSI7 and 5FWIUS).
		keepQueue(pi, macMachine());
		return;
	}
	if (process.platform !== "linux") return;
	const own = ownCgroup();
	placeWork(pi, own);
	keepQueue(pi, linuxMachine(own));
	sayBackgroundTurns(pi, sayTypedTurns(pi));
}

/** How often a turn looks again at whether its pi may yield the CPU. */
const SETTLE_MS = 5_000;

/**
 * Says, by a file of this pid, while a turn a person typed runs, so the
 * traffic shaper sends its request ahead of autonomous sessions'
 * (lib/internal/priority/typed.ts). A subagent never has one.
 */
export function sayTypedTurns(
	pi: Pick<ExtensionAPI, "on">,
): ReturnType<typeof typedTurns> {
	const turns = typedTurns(
		process.env.SUBAGENT_RUN_ID ? undefined : typedDir(),
	);
	pi.on("input", async (event) => {
		if (event.source === "interactive") turns.typed();
	});
	pi.on("agent_start", async () => turns.began());
	pi.on("agent_end", async () => turns.ended());
	// Every shutdown, a reload's included: its follower outlives the runtime.
	pi.on("session_shutdown", async () => turns.stop());
	return turns;
}

/**
 * Says, by a file of this pid, while this pi in the terminal runs a turn
 * nobody typed and the person hasn't touched it for a minute, so the
 * jobs-sorter can give its scope a low CPU weight
 * (lib/internal/priority/background.ts). A key takes the file away at
 * once. A subagent, or a pi in RPC or print mode, never has one.
 */
export function sayBackgroundTurns(
	pi: Pick<ExtensionAPI, "on">,
	typed: Pick<ReturnType<typeof typedTurns>, "held">,
) {
	if (process.env.SUBAGENT_RUN_ID) return;
	let turns: ReturnType<typeof backgroundTurns> | undefined;
	let unlisten: (() => void) | undefined;
	let settling: NodeJS.Timeout | undefined;
	const quiet = () => {
		if (settling) clearInterval(settling);
		settling = undefined;
	};
	pi.on("session_start", async (_event, ctx) => {
		turns?.stop();
		unlisten?.();
		turns = undefined;
		if (ctx.mode !== "tui") return;
		const own = backgroundTurns(backgroundDir(), {
			editorText: () => ctx.ui.getEditorText(),
			typed: typed.held,
		});
		turns = own;
		// Focus leaving and the pointer passing over arrive as input too,
		// and say the person is elsewhere.
		unlisten = ctx.ui.onTerminalInput((data) => {
			if (meansPresence(data)) own.key();
			return undefined;
		});
	});
	pi.on("agent_start", async () => {
		if (!turns) return;
		const own = turns;
		own.began();
		quiet();
		settling = setInterval(() => own.settle(), SETTLE_MS);
		settling.unref();
	});
	pi.on("agent_end", async () => {
		quiet();
		turns?.ended();
	});
	pi.on("session_shutdown", async () => {
		quiet();
		turns?.stop();
		unlisten?.();
	});
}

/** What the queue reads of the machine it keeps, on each kind of machine. */
interface Machine {
	readonly processes: Parameters<typeof queueFolder>[1];
	/** The machine's room now, read off pi's main thread. */
	readonly room: () => Promise<Reading>;
	readonly cgroupFor: (job: Job) => string | undefined;
	readonly rules: () => Rules;
	/**
	 * Have the daemon's builds give way while a deploy's stamp runs, from
	 * the queue kept in `dir`, where the machine can.
	 */
	readonly yieldBuilds?: (dir: string) => Promise<void>;
}

function linuxMachine(own: string | undefined): Machine {
	const timedProcs = own ? jobsProcs(own, process.env.TIMED_CGROUP) : undefined;
	const timed = timedProcs ? dirname(timedProcs) : undefined;
	const hasTimed = () => timed !== undefined && existsSync(timed);
	let floors: string[] = [];
	let floorsAt = Number.NEGATIVE_INFINITY;
	return {
		processes: {
			isRunning,
			cgroupOf,
			ownedPeakOf: (cgroup, shell) => ownedMemoryPeakOf(cgroup, shell),
			commandsIn: (cgroup) => commandsIn(cgroup),
		},
		room: async () => {
			const now = Date.now();
			if (now - floorsAt >= FLOORS_MS) {
				floors = await floorsIn(KERNEL.cgroups);
				floorsAt = now;
			}
			return readRoom(floors);
		},
		cgroupFor: (job) =>
			CLASS_OF[job.kind] === "timed" && hasTimed() ? timed : undefined,
		// Until VM tests run timed, a build waits while a VM check runs.
		rules: () => ({ buildsWaitForVmChecks: !hasTimed() }),
		yieldBuilds: async (dir) => {
			const slice = systemBuildSlice(KERNEL.cgroups);
			const yielding = await buildsShouldYield(await queueIn(dir), slice, {
				first: questsFirstIn(dir),
			});
			await keepYield(dir, yielding, slice);
		},
	};
}

/** The queue's whole record, or nothing while it can't be read. */
async function queueIn(dir: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(join(dir, "queue.json"), "utf8"));
	} catch {
		// A record being replaced is read whole on the next keep.
		return undefined;
	}
}

function macMachine(): Machine {
	const room = darwinRoom();
	return {
		// No cgroups to say what a job's processes are or held.
		processes: { isRunning, cgroupOf: () => undefined },
		// Read on the main thread still: its facts come from a program run
		// synchronously (room-darwin.ts).
		room: async () => room(),
		cgroupFor: () => undefined,
		rules: () => ({ buildsWaitForVmChecks: true }),
	};
}

function placeWork(pi: ExtensionAPI, own: string | undefined) {
	const path = own ? jobsProcs(own, process.env.JOBS_CGROUP) : undefined;
	if (!path) return;
	if (existsSync(path)) {
		placeChildren(path);
		return;
	}
	let said = false;
	pi.on("session_start", async (_event, ctx) => {
		if (said || !ctx.hasUI) return;
		said = true;
		ctx.ui.notify(
			`JOBS_CGROUP names ${path}, which isn't there, so what pi starts runs at pi's own priority.`,
			"warning",
		);
	});
}

function keepQueue(pi: ExtensionAPI, machine: Machine) {
	const dir = machineQueueDir();
	if (!dir) return;
	const { cgroupFor } = machine;
	const folder = queueFolder(
		dir,
		machine.processes,
		machine.rules,
		join(stateDir("priority-workflow"), "outcomes.jsonl"),
	);

	// The room as last read, for a turn asked for between keeps.
	let latest: { readonly reading: Reading; readonly at: number } | undefined;
	const readNow = async (): Promise<Reading> => {
		const reading = await machine.room();
		latest = { reading, at: Date.now() };
		return reading;
	};
	const recent = (): Reading | undefined =>
		latest !== undefined && Date.now() - latest.at < RECENT_ROOM_MS
			? latest.reading
			: undefined;
	// One keep at a time: a reading that outlasts the tick isn't read twice.
	let keeping = false;
	const keepNow = async () => {
		try {
			const now = Date.now();
			const wanted = folder.hasJobs() || folder.isDue(now);
			if (!wanted || folder.keptFresh(now)) return;
			// Another session reading the machine keeps it with what it reads.
			const handBack = claimReading(dir, now);
			if (!handBack) return;
			try {
				const reading = await readNow();
				folder.keep(reading, Date.now(), cgroupFor);
				await machine.yieldBuilds?.(dir);
			} finally {
				handBack();
			}
		} catch {
			// A folder that can't be kept this time is kept on the next.
		}
	};

	let timer: ReturnType<typeof setInterval> | undefined;
	let undo: (() => void) | undefined;
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		undo?.();
		undo = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		stop();
		undo = queueHeavyWork({
			folder,
			session: ctx.sessionManager.getSessionId(),
			room: recent,
			cgroupFor,
			sendsWholeRun: (command, cwd) =>
				sendsWholeRun(command, cwd, takesKnown()),
		});
		timer = setInterval(() => {
			if (keeping) return;
			keeping = true;
			void keepNow().finally(() => {
				keeping = false;
			});
		}, KEEP_MS);
		timer.unref();
	});

	pi.on("session_shutdown", async () => stop());

	// A changed-checks run asks what nix-offload takes before it spawns,
	// so even a session's first is held to what a sent run needs. Heavy
	// work has the room read for it, so its turn can be given as it asks.
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const { command } = event.input;
		if (runsChangedChecks(command)) await takesNow();
		if (kindOf(command, { cwd: ctx.cwd, home: homedir() }) !== undefined)
			await readNow().catch(() => undefined);
	});
}

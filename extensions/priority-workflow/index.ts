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
 * on while any session runs. Off Linux, nothing changes.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queueFolder } from "../../lib/internal/priority/folder.ts";
import { jobsProcs, placeChildren } from "../../lib/internal/priority/place.ts";
import { CLASS_OF, type Job } from "../../lib/internal/priority/queue.ts";
import {
	cgroupOf,
	floorsIn,
	isRunning,
	KERNEL,
	readRoom,
} from "../../lib/internal/priority/room.ts";
import { queueHeavyWork } from "../../lib/internal/priority/turn.ts";

/** How often a session keeps the queue. */
const KEEP_MS = 2_000;

/** How often the memory floors are looked for again. */
const FLOORS_MS = 5 * 60_000;

function ownCgroup(): string | undefined {
	try {
		return readFileSync("/proc/self/cgroup", "utf8");
	} catch {
		return undefined;
	}
}

export default function priorityWorkflow(pi: ExtensionAPI) {
	if (process.platform !== "linux") return;
	const own = ownCgroup();
	placeWork(pi, own);
	keepQueue(pi, own);
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

function keepQueue(pi: ExtensionAPI, own: string | undefined) {
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (!runtime) return;
	const folder = queueFolder(join(runtime, "jobs"), { isRunning, cgroupOf });
	const timedProcs = own ? jobsProcs(own, process.env.TIMED_CGROUP) : undefined;
	const timed = timedProcs ? dirname(timedProcs) : undefined;
	const cgroupFor = (job: Job) =>
		CLASS_OF[job.kind] === "timed" && timed && existsSync(timed)
			? timed
			: undefined;

	let floors: string[] = [];
	let floorsAt = -Infinity;
	const room = () => {
		const now = Date.now();
		if (now - floorsAt >= FLOORS_MS) {
			floors = floorsIn(KERNEL.cgroups);
			floorsAt = now;
		}
		return readRoom(floors);
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
			pid: process.pid,
			room,
			cgroupFor,
		});
		timer = setInterval(() => {
			const now = Date.now();
			try {
				if (folder.hasJobs() || folder.isDue(now)) {
					folder.keep(room(), now, cgroupFor);
				}
			} catch {
				// A folder that can't be kept this time is kept on the next.
			}
		}, KEEP_MS);
		timer.unref();
	});

	pi.on("session_shutdown", async () => stop());
}

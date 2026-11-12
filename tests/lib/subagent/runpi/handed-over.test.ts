/**
 * A supervisor whose fleet was handed on as its session moved keeps its
 * child, for as long as the move and no longer, and then answers to the
 * conversation that took the fleet up (lib/subagent/handing.ts).
 *
 * Run against the real supervisor script with a parent that doesn't
 * exist, as parent-exit.test.ts does, since in-process the parent is
 * the test itself and alive.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tickedOwnerNow } from "../../../../lib/internal/process-ticks.ts";
import { ReviewerArtifactsStore } from "../../../../lib/subagent/artifacts.ts";
import {
	type Parent,
	writeParent,
} from "../../../../lib/subagent/handing.ts";
import { createSupervisorStartPi } from "../../../../lib/subagent/runpi/supervisor.ts";
import { gone, noSuchProcess } from "../../../support/processes.ts";

// Real processes on a pool that may be saturated: room to be scheduled,
// not work waited on.
const APPEARS_WITHIN_MS = 60_000;

/** How long a child is watched to see it kept, past many of its watchdog's looks. */
const KEPT_FOR_MS = 2_500;

const supervisorPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../lib/subagent/runpi/supervisor.mjs",
);

/** Wait for a path to hold parseable JSON, or give up saying so. */
async function appears<T>(
	path: string,
	enough: (value: T) => boolean = () => true,
): Promise<T> {
	const until = Date.now() + APPEARS_WITHIN_MS;
	while (Date.now() < until) {
		try {
			const value = JSON.parse(await readFile(path, "utf8")) as T;
			if (enough(value)) return value;
		} catch {
			// Not written, or half-written. Both mean "not yet".
		}
		// A poll's pause, for the supervisor to write.
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`${path} never appeared within ${APPEARS_WITHIN_MS}ms`);
}

/** Whether a process is still there. */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// Nobody is wearing it.
		return false;
	}
}

interface Started {
	readonly root: string;
	readonly supervisor: ChildProcess;
	readonly child: number;
	readonly resultPath: string;
	readonly runDir: string;
}

/**
 * Start a supervisor whose request names a parent that has gone, with
 * `parent` written in its run's folder first, as a moving session
 * leaves it.
 */
async function startHandedOver(
	parent: (root: string) => Promise<Parent>,
): Promise<Started> {
	const root = await mkdtemp(join(tmpdir(), "handed-over-"));
	const childPath = join(root, "child.mjs");
	// A timer, so node has a handle to keep it running.
	await writeFile(childPath, "setInterval(() => {}, 1000);\n");
	const startPi = createSupervisorStartPi({
		piInstall: { node: process.execPath, entry: childPath },
		stateDir: root,
		idleTimeoutMs: 600_000,
		timeoutMs: 600_000,
		spawn: (() => ({ pid: 1, unref() {}, on() {} })) as never,
	});
	const started = await startPi({
		args: [],
		cwd: root,
		runId: "run",
		reviewerId: "one",
	});
	const request = JSON.parse(await readFile(started.requestPath, "utf8"));
	await writeFile(
		started.requestPath,
		JSON.stringify({ ...request, parentPid: noSuchProcess() }),
	);
	const store = new ReviewerArtifactsStore(root);
	const { resultPath, leasePath, runDir } = store.paths("run", "one");
	writeParent(runDir, await parent(root));
	const supervisor = spawn(process.execPath, [supervisorPath, started.requestPath], {
		cwd: root,
		detached: false,
		stdio: "ignore",
	});
	const lease = await appears<{ childPid?: number }>(
		leasePath,
		(value) => typeof value.childPid === "number",
	);
	if (lease.childPid === undefined) throw new Error("the lease named no child");
	return { root, supervisor, child: lease.childPid, resultPath, runDir };
}

async function stop(started: Started | undefined): Promise<void> {
	if (started === undefined) return;
	started.supervisor.kill("SIGKILL");
	try {
		process.kill(-started.child, "SIGKILL");
	} catch {
		// Already gone, which most cases here end with.
	}
	await rm(started.root, { recursive: true, force: true });
}

/** A move note's folder holding a claim on `session`'s note, as a cutover adopting it does. */
async function claimedNote(root: string, session: string): Promise<string> {
	const folder = join(root, "moves");
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, `${session}.adopting-1`), "{}\n");
	return folder;
}

describe("a supervisor handed over as its session moved", () => {
	it("keeps its child while the move's note is out, and stops it a margin after the note goes", async () => {
		let started: Started | undefined;
		let folder = "";
		try {
			started = await startHandedOver(async (root) => {
				folder = await claimedNote(root, "moving");
				return {
					handing: {
						since: new Date().toISOString(),
						note: { session: "moving", folder },
						mostMs: 600_000,
						marginMs: 1_000,
					},
				};
			});
			// Watched for many of the watchdog's looks, past the margin.
			await new Promise((resolve) => setTimeout(resolve, KEPT_FOR_MS));
			expect(running(started.child)).toBe(true);

			await rm(join(folder, "moving.adopting-1"));
			const result = await appears<{ state: string }>(started.resultPath);
			expect(result.state).toBe("parent-exit");
			await gone(started.child, APPEARS_WITHIN_MS);
		} finally {
			await stop(started);
		}
	}, 120_000);

	it("keeps its child through a hang-up, which a closing window sends", async () => {
		let started: Started | undefined;
		try {
			started = await startHandedOver(async (root) => ({
				handing: {
					since: new Date().toISOString(),
					note: { session: "moving", folder: await claimedNote(root, "moving") },
					mostMs: 600_000,
					marginMs: 600_000,
				},
			}));
			started.supervisor.kill("SIGHUP");
			// Long enough for a hang-up taken as a stop to have stopped it.
			await new Promise((resolve) => setTimeout(resolve, KEPT_FOR_MS));
			expect(running(started.child)).toBe(true);
		} finally {
			await stop(started);
		}
	}, 120_000);

	it("answers to the owner that took it up, not the parent its request named", async () => {
		let started: Started | undefined;
		try {
			const owner = await tickedOwnerNow();
			if (!owner) throw new Error("test process has no identity");
			started = await startHandedOver(async () => ({ owner }));
			// Watched for many of the watchdog's looks.
			await new Promise((resolve) => setTimeout(resolve, KEPT_FOR_MS));
			expect(running(started.child)).toBe(true);

			writeParent(started.runDir, {
				owner: { pid: noSuchProcess(), startedAt: owner.startedAt },
			});
			const result = await appears<{ state: string }>(started.resultPath);
			expect(result.state).toBe("parent-exit");
		} finally {
			await stop(started);
		}
	}, 120_000);
});

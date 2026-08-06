import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.js";
import { recoverReviewerRuns } from "../../../lib/subagent/recovery.js";

async function tempStore(): Promise<ReviewerArtifactsStore> {
	return new ReviewerArtifactsStore(
		await mkdtemp(join(tmpdir(), "pr-recovery-")),
	);
}

describe("recoverReviewerRuns", () => {
	it("recovers completed reviewer results from durable artifacts", async () => {
		const store = await tempStore();
		const paths = await store.ensureReviewerDir("run", "fast");
		await store.writeJsonAtomic(paths.resultPath, {
			state: "complete",
			exitCode: 0,
			finalAssistantText: "done",
			warnings: ["kept"],
		});

		const recovery = await recoverReviewerRuns(store);

		expect(recovery.completed).toHaveLength(1);
		expect(recovery.completed[0]).toMatchObject({
			runId: "run",
			reviewerId: "fast",
			finalAssistantText: "done",
			warnings: ["kept"],
		});
	});

	it("reports active reviewers when the supervisor pid is alive", async () => {
		const store = await tempStore();
		const paths = await store.ensureReviewerDir("run", "fast");
		await store.writeJsonAtomic(paths.progressPath, {
			state: "running",
			activity: "reading x",
			updatedAt: "2026-01-01T00:00:00Z",
		});
		await store.writeJsonAtomic(paths.leasePath, {
			state: "running",
			supervisorPid: process.pid,
		});

		const recovery = await recoverReviewerRuns(store);

		expect(recovery.active).toHaveLength(1);
		expect(recovery.active[0]).toMatchObject({ activity: "reading x" });
	});

	it("marks missing-supervisor reviewers stale and writes a cancel sentinel", async () => {
		const store = await tempStore();
		const paths = await store.ensureReviewerDir("run", "fast");
		await store.writeJsonAtomic(paths.progressPath, {
			state: "running",
			activity: "bash test",
			updatedAt: "2026-01-01T00:00:00Z",
		});
		await store.writeJsonAtomic(paths.leasePath, {
			state: "running",
			supervisorPid: 99999999,
		});

		const recovery = await recoverReviewerRuns(store);

		expect(recovery.stale).toHaveLength(1);
		expect(await store.readJson(paths.cancelPath)).toMatchObject({
			reason: "startup-stale",
		});
	});

	it("kills the reviewer a dead supervisor left behind", async () => {
		// The cancel sentinel above is read by the supervisor, and the
		// supervisor is the thing that died. Without this its reviewer
		// runs on to its own backstop, three quarters of an hour of a
		// large model with nobody left to give the answer to.
		const store = await tempStore();
		const paths = await store.ensureReviewerDir("run", "fast");
		await store.writeJsonAtomic(paths.leasePath, {
			state: "running",
			supervisorPid: 99999999,
			childPid: process.pid,
			childStartedAt: 1_000_000,
		});
		const killed: number[] = [];

		const recovery = await recoverReviewerRuns(store, {
			startedAt: async () => 1_000_000,
			kill: (pid) => killed.push(pid),
		});

		expect(killed).toEqual([process.pid]);
		expect(recovery.reaped).toEqual([
			{ runId: "run", reviewerId: "fast", pid: process.pid },
		]);
	});

	it("spares a pid the machine has since given to somebody else", async () => {
		// A pid identifies nothing on its own. This lease was written
		// about a process that has been gone for a while, and the number
		// now belongs to something with no connection to us at all: the
		// only evidence of that is that it started after we spawned ours.
		const store = await tempStore();
		const paths = await store.ensureReviewerDir("run", "fast");
		await store.writeJsonAtomic(paths.leasePath, {
			state: "running",
			supervisorPid: 99999999,
			childPid: process.pid,
			childStartedAt: 1_000_000,
		});
		const killed: number[] = [];

		const recovery = await recoverReviewerRuns(store, {
			startedAt: async () => 1_000_000 + 60_000,
			kill: (pid) => killed.push(pid),
		});

		expect(killed).toEqual([]);
		expect(recovery.reaped).toEqual([]);
	});

	it("spares a reviewer whose start time nothing can report", async () => {
		// A platform with no ps, or a process that vanished between the
		// liveness check and the question. Refusing is the only safe
		// reading: the cost is a reviewer that runs to its backstop, and
		// the cost of guessing is killing a stranger.
		const store = await tempStore();
		const paths = await store.ensureReviewerDir("run", "fast");
		await store.writeJsonAtomic(paths.leasePath, {
			state: "running",
			supervisorPid: 99999999,
			childPid: process.pid,
			childStartedAt: 1_000_000,
		});
		const killed: number[] = [];

		await recoverReviewerRuns(store, {
			startedAt: async () => undefined,
			kill: (pid) => killed.push(pid),
		});

		expect(killed).toEqual([]);
	});

	it("leaves a finished reviewer's pid alone", async () => {
		// A lease that says it completed is describing a supervisor that
		// exited on purpose. Its child is long gone and the pid belongs
		// to whatever came after.
		const store = await tempStore();
		const paths = await store.ensureReviewerDir("run", "fast");
		await store.writeJsonAtomic(paths.leasePath, {
			state: "complete",
			supervisorPid: 99999999,
			childPid: process.pid,
			childStartedAt: 1_000_000,
			completedAt: "2026-01-01T00:00:00Z",
		});
		const killed: number[] = [];

		await recoverReviewerRuns(store, {
			startedAt: async () => 1_000_000,
			kill: (pid) => killed.push(pid),
		});

		expect(killed).toEqual([]);
	});
});

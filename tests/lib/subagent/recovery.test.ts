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

	it("names a stale reviewer once, not at every session start", async () => {
		// Nothing empties this population: the progress and lease files
		// stay as they are, so every later session finds the same runs
		// and a caller reporting what it found would print the same line
		// forever. The cancellation on disk is the record that somebody
		// has been here, and it is the only marker that outlives the
		// process that wrote it.
		const store = await tempStore();
		const paths = await store.ensureReviewerDir("run", "fast");
		await store.writeJsonAtomic(paths.progressPath, {
			state: "running",
			activity: "reading x",
			updatedAt: "2026-01-01T00:00:00Z",
		});
		await store.writeJsonAtomic(paths.leasePath, {
			state: "running",
			supervisorPid: 4242,
			supervisorStartedAt: 1_000_000,
			updatedAt: new Date().toISOString(),
		});
		const machine = {
			alive: () => false,
			startedAt: async () => undefined,
			kill: () => {},
			wait: async () => {},
		};

		const first = await recoverReviewerRuns(store, machine);
		const second = await recoverReviewerRuns(store, machine);

		expect(first.stale).toHaveLength(1);
		expect(second.stale).toEqual([]);
		// Still cancelled, though. Saying it twice is noise; leaving a
		// run uncancelled because it was mentioned once is a bug.
		expect(
			await store.readJson<{ reason: string }>(paths.cancelPath),
		).toMatchObject({ reason: "startup-stale" });
	});

	it("files a supervisor whose pid the machine reissued as gone", async () => {
		// Recovery used to ask only whether the pid was alive, which the
		// collect path had already learned not to trust. The asymmetry
		// bit hardest here: a recycled pid read as a healthy supervisor,
		// so no cancellation was written and the orphan holding a model
		// was never reached.
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
			supervisorStartedAt: 1_000_000,
			updatedAt: new Date().toISOString(),
		});

		const recovery = await recoverReviewerRuns(store, {
			alive: () => true,
			// Whatever is wearing that pid today, it is not the
			// supervisor this lease was written about.
			startedAt: async () => 9_000_000,
			kill: () => {},
			wait: async () => {},
		});

		expect(recovery.active).toEqual([]);
		expect(recovery.stale).toHaveLength(1);
	});
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../extensions/pr-workflow/reviewer-artifacts.js";
import { recoverReviewerRuns } from "../../../extensions/pr-workflow/reviewer-recovery.js";

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
});

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../extensions/pr-workflow/reviewer-artifacts.js";

async function tempStore(): Promise<ReviewerArtifactsStore> {
	return new ReviewerArtifactsStore(
		await mkdtemp(join(tmpdir(), "pr-reviewers-")),
	);
}

describe("ReviewerArtifactsStore", () => {
	it("builds sanitized reviewer paths under the run directory", () => {
		const store = new ReviewerArtifactsStore("/tmp/state");

		const paths = store.paths("run/one", "reviewer:fast");

		expect(paths.runDir).toBe("/tmp/state/runs/run-one");
		expect(paths.reviewerDir).toBe(
			"/tmp/state/runs/run-one/reviewers/reviewer-fast",
		);
		expect(paths.resultPath).toBe(`${paths.reviewerDir}/result.json`);
	});

	it("writes JSON atomically and reads it back", async () => {
		const store = await tempStore();
		const path = store.paths("run", "fast").resultPath;

		await store.writeJsonAtomic(path, { ok: true });

		expect(await store.readJson(path)).toEqual({ ok: true });
	});

	it("appends only while the capped artifact stays under its limit", async () => {
		const store = await tempStore();
		const path = join(store.stateDir, "events.ndjson");

		expect(await store.appendCapped(path, Buffer.from("abc"), 5)).toMatchObject(
			{
				written: true,
				limitExceeded: false,
			},
		);
		expect(await store.appendCapped(path, Buffer.from("def"), 5)).toMatchObject(
			{
				written: false,
				limitExceeded: true,
			},
		);
		expect(await readFile(path, "utf-8")).toBe("abc");
	});

	it("cleans up old terminal runs without deleting active ones", async () => {
		const store = await tempStore();
		const terminal = store.paths("old", "fast");
		const active = store.paths("active", "fast");
		await store.writeJsonAtomic(terminal.resultPath, { ok: true });
		await store.writeJsonAtomic(active.progressPath, { state: "running" });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 0,
			now: new Date(),
		});

		expect(result.removed).toBe(1);
		await expect(stat(terminal.runDir)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect((await stat(active.runDir)).isDirectory()).toBe(true);
	});

	it("writes run and reviewer cancellation requests", async () => {
		const store = await tempStore();

		await store.requestRunCancellation("run", "user");
		await store.requestReviewerCancellation("run", "fast", "user");

		expect(
			await store.readJson(store.rootPaths("run").cancelPath),
		).toMatchObject({
			reason: "user",
		});
		expect(
			await store.readJson(store.paths("run", "fast").cancelPath),
		).toMatchObject({
			reason: "user",
		});
	});

	it("overwrites existing JSON through the atomic path", async () => {
		const store = await tempStore();
		const path = (await store.ensureReviewerDir("run", "fast")).leasePath;
		await writeFile(path, '{"state":"old"}\n');

		await store.writeJsonAtomic(path, { state: "new" });

		expect(await store.readJson(path)).toEqual({ state: "new" });
	});
});

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.js";

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

	it("keeps a protected run however finished and however old", async () => {
		// A round detached from its session writes every result file and
		// then waits to be collected, so to this sweep it is a finished
		// round nobody needs. Deleting it throws away reviews that have
		// been paid for and leaves a ledger entry pointing at nothing.
		const store = await tempStore();
		const waiting = store.paths("uncollected", "fast");
		const finished = store.paths("collected", "fast");
		await store.writeJsonAtomic(waiting.resultPath, { ok: true });
		await store.writeJsonAtomic(finished.resultPath, { ok: true });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 0,
			protect: new Set(["uncollected"]),
			now: new Date(),
		});

		expect(result.removed).toBe(1);
		expect((await stat(waiting.runDir)).isDirectory()).toBe(true);
		await expect(stat(finished.runDir)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("reclaims a run abandoned long enough that recovery is moot", async () => {
		// A run killed before its reviewer wrote a result is never
		// terminal, so the terminal-only rule can never reclaim it and it
		// lives forever. Two such runs, 24 and 28 days old, were found on
		// disk after a month of use.
		const store = await tempStore();
		const abandoned = store.paths("abandoned", "fast");
		await store.writeJsonAtomic(abandoned.progressPath, { state: "running" });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: 60_000,
			maxRuns: 100,
			abandonedAfterMs: -1,
			now: new Date(),
		});

		expect(result.removed).toBe(1);
		await expect(stat(abandoned.runDir)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("keeps an unfinished run while recovery is still plausible", async () => {
		// The reason the abandoned window is separate from the terminal
		// one: a run that is merely in progress must survive a cleanup
		// that is aggressive about finished ones.
		const store = await tempStore();
		const active = store.paths("active", "fast");
		await store.writeJsonAtomic(active.progressPath, { state: "running" });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 0,
			abandonedAfterMs: 60_000,
			now: new Date(),
		});

		expect(result.removed).toBe(0);
		expect((await stat(active.runDir)).isDirectory()).toBe(true);
	});

	it("leaves unfinished runs alone when no abandoned window is set", async () => {
		// The policy predates the window, so an omitted one has to mean
		// "never reclaim an unfinished run" rather than "reclaim it now".
		const store = await tempStore();
		const active = store.paths("active", "fast");
		await store.writeJsonAtomic(active.progressPath, { state: "running" });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 0,
			now: new Date(),
		});

		expect(result.removed).toBe(0);
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

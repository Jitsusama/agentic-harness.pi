import { describe, expect, it } from "vitest";
import { ReviewerCancellationRegistry } from "../../../extensions/pr-workflow/cancellation.js";
import type {
	WorktreeHandle,
	WorktreeProvider,
} from "../../../extensions/pr-workflow/worktree.js";
import { WorktreeRegistry } from "../../../extensions/pr-workflow/worktree.js";
import { reclaimWorktrees } from "../../../extensions/pr-workflow/worktree-reclaim.js";

function recordingProvider(released: string[]): WorktreeProvider {
	return {
		id: "fake",
		async ensure(req) {
			return {
				path: `/wt/${req.sha}`,
				sha: req.sha,
				providerId: "fake",
				reusable: true,
				createdAt: new Date(0),
			};
		},
		async release(handle: WorktreeHandle) {
			released.push(handle.sha);
		},
	};
}

describe("reclaimWorktrees", () => {
	it("releases every active handle when no run is in flight", async () => {
		const released: string[] = [];
		const registry = new WorktreeRegistry(recordingProvider(released));
		await registry.ensure({ owner: "o", repo: "r", sha: "aaa" });
		await registry.ensure({ owner: "o", repo: "r", sha: "bbb" });

		const result = await reclaimWorktrees(
			registry,
			new ReviewerCancellationRegistry(),
		);

		expect(result.released).toBe(2);
		expect(result.errors).toEqual([]);
		expect(released.sort()).toEqual(["aaa", "bbb"]);
		expect(registry.active()).toEqual([]);
	});

	it("waits for an in-flight run to drain before releasing", async () => {
		const released: string[] = [];
		const registry = new WorktreeRegistry(recordingProvider(released));
		await registry.ensure({ owner: "o", repo: "r", sha: "aaa" });

		const cancellations = new ReviewerCancellationRegistry();
		const run = cancellations.beginRun("council");

		const reclaim = reclaimWorktrees(registry, cancellations);

		// The run is still active, so nothing is released yet.
		await Promise.resolve();
		expect(released).toEqual([]);

		// The cancelled run winds down and ends.
		run.end();
		const result = await reclaim;

		expect(result.released).toBe(1);
		expect(released).toEqual(["aaa"]);
	});

	it("releases after the drain timeout even if a run never ends", async () => {
		const released: string[] = [];
		const registry = new WorktreeRegistry(recordingProvider(released));
		await registry.ensure({ owner: "o", repo: "r", sha: "aaa" });

		const cancellations = new ReviewerCancellationRegistry();
		// A run that ignores its cancellation and never ends.
		cancellations.beginRun("council");

		const result = await reclaimWorktrees(registry, cancellations, {
			drainTimeoutMs: 20,
		});

		expect(result.released).toBe(1);
		expect(released).toEqual(["aaa"]);
	});

	it("reports only the handles that actually released", async () => {
		let calls = 0;
		const provider: WorktreeProvider = {
			id: "flaky",
			async ensure(req) {
				return {
					path: `/wt/${req.sha}`,
					sha: req.sha,
					providerId: "flaky",
					reusable: true,
					createdAt: new Date(0),
				};
			},
			async release() {
				calls += 1;
				if (calls === 1) throw new Error("dev tree remove failed");
			},
		};
		const registry = new WorktreeRegistry(provider);
		await registry.ensure({ owner: "o", repo: "r", sha: "aaa" });
		await registry.ensure({ owner: "o", repo: "r", sha: "bbb" });

		const result = await reclaimWorktrees(
			registry,
			new ReviewerCancellationRegistry(),
		);

		expect(result.released).toBe(1);
		expect(result.errors.length).toBe(1);
	});

	it("collects release failures instead of throwing", async () => {
		const provider: WorktreeProvider = {
			id: "boom",
			async ensure(req) {
				return {
					path: `/wt/${req.sha}`,
					sha: req.sha,
					providerId: "boom",
					reusable: true,
					createdAt: new Date(0),
				};
			},
			async release() {
				throw new Error("dev tree remove failed");
			},
		};
		const registry = new WorktreeRegistry(provider);
		await registry.ensure({ owner: "o", repo: "r", sha: "aaa" });

		const result = await reclaimWorktrees(
			registry,
			new ReviewerCancellationRegistry(),
		);

		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toContain("dev tree remove failed");
	});
});

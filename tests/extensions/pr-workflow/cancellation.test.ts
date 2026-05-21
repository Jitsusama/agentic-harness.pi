import { describe, expect, it } from "vitest";
import {
	createCancellableDispatch,
	formatCancellationOutcome,
	ReviewerCancellationRegistry,
	ReviewerCancelledError,
} from "../../../extensions/pr-workflow/cancellation.js";
import type { CouncilDispatch } from "../../../extensions/pr-workflow/council.js";

function successfulDispatch(): CouncilDispatch {
	return async (opts) => ({
		reviewerId: opts.reviewer.id,
		exitCode: 0,
		finalAssistantText: JSON.stringify({ findings: [] }),
		stderr: "",
		warnings: [],
	});
}

describe("ReviewerCancellationRegistry", () => {
	it("cancels one active reviewer by id", async () => {
		const registry = new ReviewerCancellationRegistry();
		const run = registry.beginRun("council");
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let observedSignal: AbortSignal | undefined;
		const dispatch = createCancellableDispatch(run, async (opts) => {
			observedSignal = opts.signal;
			await blocked;
			return successfulDispatch()(opts);
		});
		const promise = dispatch({
			reviewer: { id: "slow" },
			prompt: "p",
			cwd: "/tmp",
		});

		const outcome = registry.cancel("slow");
		release();

		expect(outcome).toMatchObject({
			ok: true,
			mode: "one",
			reviewerId: "slow",
		});
		expect(observedSignal?.aborted).toBe(true);
		await expect(promise).rejects.toBeInstanceOf(ReviewerCancelledError);
		run.end();
	});

	it("cancels a future reviewer in the active run by id", async () => {
		const registry = new ReviewerCancellationRegistry();
		const run = registry.beginRun("review");
		const dispatch = createCancellableDispatch(run, successfulDispatch());

		const outcome = registry.cancel("judge");

		expect(outcome).toMatchObject({
			ok: true,
			mode: "one",
			reviewerId: "judge",
		});
		await expect(
			dispatch({ reviewer: { id: "judge" }, prompt: "p", cwd: "/tmp" }),
		).rejects.toBeInstanceOf(ReviewerCancelledError);
		run.end();
	});

	it("cancels all current and future reviewers in the active run", async () => {
		const registry = new ReviewerCancellationRegistry();
		const run = registry.beginRun("review");
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const dispatch = createCancellableDispatch(run, async (opts) => {
			await blocked;
			return successfulDispatch()(opts);
		});
		const first = dispatch({
			reviewer: { id: "fast" },
			prompt: "p",
			cwd: "/tmp",
		});

		const outcome = registry.cancel();
		release();

		expect(outcome).toMatchObject({ ok: true, mode: "all", count: 1 });
		await expect(first).rejects.toBeInstanceOf(ReviewerCancelledError);
		await expect(
			dispatch({ reviewer: { id: "judge" }, prompt: "p", cwd: "/tmp" }),
		).rejects.toBeInstanceOf(ReviewerCancelledError);
		run.end();
	});

	it("formats missing cancellation requests as a user-facing error", () => {
		const registry = new ReviewerCancellationRegistry();
		const outcome = registry.cancel("ghost");

		expect(outcome.ok).toBe(false);
		expect(formatCancellationOutcome(outcome)).toContain("No active reviewer");
	});
});

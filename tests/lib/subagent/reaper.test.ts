/**
 * Killing a process by a number read off a file.
 *
 * The least forgiving thing in this package, so every guard has a case
 * that turns on it alone: the fakes answer about the pid they are
 * asked rather than returning a constant, and each test moves one
 * fact. A stub that ignores its argument would pass all of these
 * against a reaper that killed whatever it liked.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.js";
import { systemFacts } from "../../../lib/subagent/lease.js";
import type { ReaperDeps } from "../../../lib/subagent/recovery.js";
import { recoverReviewerRuns } from "../../../lib/subagent/recovery.js";

const CHILD = 4242;
const SPAWNED = 1_000_000;
/** A pid nothing on this machine is wearing. */
const DEAD_SUPERVISOR = 99999999;

async function tempStore(): Promise<ReviewerArtifactsStore> {
	return new ReviewerArtifactsStore(await mkdtemp(join(tmpdir(), "pr-reap-")));
}

/**
 * A machine with exactly one process on it.
 *
 * Answers about the pid it is asked, so a reaper that muddles the
 * child's pid with the supervisor's fails rather than passing.
 */
function machine(options: {
	pid?: number;
	startedAt?: number | undefined;
	diesOnTerm?: boolean;
}) {
	const only = options.pid ?? CHILD;
	const signals: { pid: number; signal: string }[] = [];
	let running = true;
	const deps: ReaperDeps = {
		alive: (pid) => pid === only && running,
		startedAt: async (pid) => (pid === only ? options.startedAt : undefined),
		kill: (pid, signal) => {
			signals.push({ pid, signal });
			if (signal === "SIGKILL" || options.diesOnTerm !== false) {
				running = false;
			}
		},
		wait: async () => {},
	};
	return { deps, signals };
}

/** A reviewer whose supervisor is gone, with the lease it left. */
async function orphan(
	lease: Record<string, unknown>,
): Promise<ReviewerArtifactsStore> {
	const store = await tempStore();
	const paths = await store.ensureReviewerDir("run", "fast");
	await store.writeJsonAtomic(paths.leasePath, {
		state: "running",
		supervisorPid: DEAD_SUPERVISOR,
		childPid: CHILD,
		childStartedAt: SPAWNED,
		...lease,
	});
	return store;
}

describe("reaping a reviewer whose supervisor died", () => {
	it("kills the process group, not the process", async () => {
		// The reviewer is spawned detached and leads its own group, so
		// signalling the pid alone orphans the tools it started, which
		// is this same bug one level down.
		const store = await orphan({});
		const { deps, signals } = machine({ startedAt: SPAWNED });

		const recovery = await recoverReviewerRuns(store, deps);

		expect(signals).toEqual([{ pid: CHILD, signal: "SIGTERM" }]);
		expect(recovery.reaped).toEqual([
			{ runId: "run", reviewerId: "fast", pid: CHILD },
		]);
	});

	it("escalates when the reviewer ignores the first signal", async () => {
		// A kill nobody confirms is a report rather than an outcome.
		const store = await orphan({});
		const { deps, signals } = machine({
			startedAt: SPAWNED,
			diesOnTerm: false,
		});

		await recoverReviewerRuns(store, deps);

		expect(signals).toEqual([
			{ pid: CHILD, signal: "SIGTERM" },
			{ pid: CHILD, signal: "SIGKILL" },
		]);
	});

	it("spares a pid the machine has since given to somebody else", async () => {
		// The recycled pid, which is the whole reason for the guard: the
		// process wearing this number today started long after ours did.
		const store = await orphan({});
		const { deps, signals } = machine({ startedAt: SPAWNED + 60_000 });

		await recoverReviewerRuns(store, deps);

		expect(signals).toEqual([]);
	});

	it("spares a pid that has been around far longer than our child", async () => {
		// The other side of the same guard, and the one a one-sided
		// comparison lets through. A truncated or garbage lease can name
		// a pid like 1, and 1 started at boot: emphatically earlier, and
		// emphatically not ours.
		const store = await orphan({});
		const { deps, signals } = machine({ startedAt: SPAWNED - 60 * 60_000 });

		await recoverReviewerRuns(store, deps);

		expect(signals).toEqual([]);
	});

	it("spares a reviewer whose start time nothing can report", async () => {
		// A platform with no ps, or a process table too wedged to answer.
		// Refusing costs one reviewer running to its backstop; guessing
		// signals a stranger.
		const store = await orphan({});
		const { deps, signals } = machine({ startedAt: undefined });

		await recoverReviewerRuns(store, deps);

		expect(signals).toEqual([]);
	});

	it("spares a reviewer whose lease never recorded a birth", async () => {
		// A lease written by an older supervisor, before there was
		// anything to compare against.
		const store = await orphan({ childStartedAt: null });
		const { deps, signals } = machine({ startedAt: SPAWNED });

		await recoverReviewerRuns(store, deps);

		expect(signals).toEqual([]);
	});

	it("spares a pid nothing is wearing", async () => {
		const store = await orphan({});
		const { deps, signals } = machine({ pid: 5555, startedAt: SPAWNED });

		await recoverReviewerRuns(store, deps);

		expect(signals).toEqual([]);
	});

	it("leaves a finished reviewer's pid alone", async () => {
		// A lease that says it completed describes a supervisor that
		// exited on purpose. Its child is long gone.
		const store = await orphan({ completedAt: "2026-01-01T00:00:00Z" });
		const { deps, signals } = machine({ startedAt: SPAWNED });

		await recoverReviewerRuns(store, deps);

		expect(signals).toEqual([]);
	});
});

describe("asking the machine for real", () => {
	it("reports this process's own start time", async () => {
		// The default is one typo from reporting undefined forever, and
		// every guard above resolves that way, so a reaper that has
		// silently turned itself off passes every test that injects a
		// fake. This is the only case that runs ps.
		const startedAt = await systemFacts.startedAt(process.pid);

		expect(startedAt).toBeTypeOf("number");
		// Started in the past, and not before this machine was built.
		expect(startedAt ?? 0).toBeLessThanOrEqual(Date.now() + 2_000);
		expect(startedAt ?? 0).toBeGreaterThan(Date.parse("2020-01-01"));
	});

	it("reports nothing about a pid nothing is wearing", async () => {
		expect(await systemFacts.startedAt(DEAD_SUPERVISOR)).toBeUndefined();
	});

	it("knows this process is alive and that one is not", () => {
		expect(systemFacts.alive(process.pid)).toBe(true);
		expect(systemFacts.alive(DEAD_SUPERVISOR)).toBe(false);
	});
});

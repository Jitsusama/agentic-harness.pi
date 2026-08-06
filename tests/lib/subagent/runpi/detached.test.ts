import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../../lib/subagent/artifacts.js";
import { createSupervisorStartPi } from "../../../../lib/subagent/runpi/supervisor.js";

// Real processes, so give the operating system room to schedule them
// under a saturated pool. Nothing here waits on work: the point of a
// detached start is that it returns before the child has done
// anything, so the only wait is for a file to appear.
const APPEARS_WITHIN_MS = 60_000;

async function tempStateDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pr-runpi-detached-"));
}

/** Wait for a path to hold parseable JSON, or give up saying so. */
async function appears<T>(path: string): Promise<T> {
	const until = Date.now() + APPEARS_WITHIN_MS;
	while (Date.now() < until) {
		try {
			return JSON.parse(await readFile(path, "utf8")) as T;
		} catch {
			// Not written, or half-written. Both mean "not yet".
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(`${path} never appeared within ${APPEARS_WITHIN_MS}ms`);
}

/** A spawn that records how it was called and pretends nothing ran. */
function noteSpawn() {
	const calls: { options: SpawnOptions }[] = [];
	let unrefs = 0;
	const spawn = (_c: string, _a: readonly string[], options: SpawnOptions) => {
		calls.push({ options });
		return {
			pid: 4321,
			unref() {
				unrefs += 1;
			},
			on() {},
		} as unknown as ChildProcess;
	};
	return { calls, spawn, unrefs: () => unrefs };
}

describe("starting a reviewer that outlives the session", () => {
	it("spawns it into its own process group, holding no pipes", async () => {
		// A child in the session's process group dies with the session,
		// which is the whole thing being fixed. Pipes matter for the
		// same reason from the other end: a parent that exits leaves
		// the child writing into a closed pipe.
		const noted = noteSpawn();
		const stateDir = await tempStateDir();
		const startPi = createSupervisorStartPi({
			piInstall: { node: process.execPath, entry: "child.mjs" },
			stateDir,
			spawn: noted.spawn,
		});

		await startPi({ args: [], cwd: stateDir, runId: "run", reviewerId: "one" });

		expect(noted.calls[0]?.options.detached).toBe(true);
		expect(noted.calls[0]?.options.stdio).toEqual([
			"ignore",
			"ignore",
			"ignore",
		]);
		expect(noted.unrefs()).toBe(1);
	});

	it("reports the pid, so a collect can tell it is still running", async () => {
		const noted = noteSpawn();
		const stateDir = await tempStateDir();
		const startPi = createSupervisorStartPi({
			piInstall: { node: process.execPath, entry: "child.mjs" },
			stateDir,
			spawn: noted.spawn,
		});

		const started = await startPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "one",
		});

		expect(started).toMatchObject({
			runId: "run",
			reviewerId: "one",
			pid: 4321,
		});
	});

	it("returns before the reviewer has finished, and it finishes anyway", async () => {
		// The one that matters. Everything else is arrangement: this
		// asserts that a real supervised reviewer runs to completion
		// with nobody waiting for it.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			`await new Promise((r) => setTimeout(r, 300));\n` +
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"nobody waited"}]}})+"\\n");`,
		);
		const startPi = createSupervisorStartPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: 30_000,
			timeoutMs: 30_000,
		});

		const started = await startPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "slow",
		});

		const store = new ReviewerArtifactsStore(stateDir);
		const { resultPath } = store.paths("run", "slow");
		const result = await appears<{ finalAssistantText: string }>(resultPath);

		expect(started.pid).toBeGreaterThan(0);
		expect(result.finalAssistantText).toBe("nobody waited");
	});
});

/**
 * The wrap-up a detached reviewer's supervisor asks for itself: when
 * one is owed, what its own supervisor is told, and how it is handed
 * over without leaving a collect held by a wrap-up that never ran.
 */

import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { told } from "../../../../lib/subagent/runpi/supervisor-request.ts";
import {
	handOver,
	wrapUpOwed,
	wrapUpRequest,
} from "../../../../lib/subagent/runpi/supervisor-wrap-up.mjs";

const SESSION = "/sessions/s.jsonl";

/** What a detached reviewer's supervisor is told, wrap-up included. */
function stoppedRun(wrapUpArgs = ["pi.js", "--session", "-", "say"]) {
	return {
		runId: "run",
		reviewerId: "slow",
		args: ["pi.js", "--session-dir", "/sessions"],
		cwd: "/work",
		timeoutMs: 4000,
		idleTimeoutMs: 4000,
		softDeadlineMs: 2500,
		paths: { requestPath: "/runs/slow/request.json" },
		wrapUp: {
			reviewerId: "slow+wrapup",
			args: wrapUpArgs,
			timeoutMs: 1500,
			idleTimeoutMs: 900,
			paths: { requestPath: "/runs/slow~2bwrapup/request.json" },
		},
	};
}

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pr-runpi-wrap-up-"));
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

describe("when a stopped reviewer is owed a wrap-up", () => {
	it.each(["timeout", "idle-timeout", "soft-deadline"])(
		"is asked when a clock stopped it: %s",
		(state) => {
			expect(wrapUpRequest(stoppedRun(), state, SESSION, false)).toBeDefined();
		},
	);

	it.each(["complete", "cancelled", "error"])(
		"asks nothing when no clock stopped it: %s",
		(state) => {
			expect(wrapUpOwed(stoppedRun(), state, false)).toBe(false);
			expect(
				wrapUpRequest(stoppedRun(), state, SESSION, false),
			).toBeUndefined();
		},
	);

	it("asks nothing of one that had already handed in a verified answer", () => {
		expect(wrapUpOwed(stoppedRun(), "timeout", true)).toBe(false);
		expect(
			wrapUpRequest(stoppedRun(), "timeout", SESSION, true),
		).toBeUndefined();
	});

	it("asks nothing when its starter spelled out no wrap-up", () => {
		const { wrapUp: _none, ...waited } = stoppedRun();

		expect(wrapUpOwed(waited, "timeout", false)).toBe(false);
	});

	it("is owed but cannot be asked without a session to resume", () => {
		// The supervisor warns on this one rather than losing the
		// reviewer's answer without a word.
		expect(wrapUpOwed(stoppedRun(), "timeout", false)).toBe(true);
		expect(
			wrapUpRequest(stoppedRun(), "timeout", undefined, false),
		).toBeUndefined();
	});

	it("is owed but cannot be asked without a session to resume it with", () => {
		const run = stoppedRun(["pi.js", "say"]);

		expect(wrapUpOwed(run, "timeout", false)).toBe(true);
		expect(wrapUpRequest(run, "timeout", SESSION, false)).toBeUndefined();
	});
});

describe("what a wrap-up's supervisor is told", () => {
	it("resumes the session the stopped run left, on its own clocks and paths", () => {
		const asked = wrapUpRequest(stoppedRun(), "soft-deadline", SESSION, false);

		expect(asked).toEqual({
			runId: "run",
			reviewerId: "slow+wrapup",
			args: ["pi.js", "--session", SESSION, "say"],
			cwd: "/work",
			timeoutMs: 1500,
			idleTimeoutMs: 900,
			paths: { requestPath: "/runs/slow~2bwrapup/request.json" },
		});
	});

	it("is given no soft deadline and no wrap-up, so it is asked at most once", () => {
		const asked = wrapUpRequest(stoppedRun(), "timeout", SESSION, false);

		expect(asked.softDeadlineMs).toBeUndefined();
		expect(asked.wrapUp).toBeUndefined();
	});
});

describe("handing a wrap-up over", () => {
	/** A wrap-up's request under a fresh folder, with what it is to run. */
	async function wrapUpIn(dir: string, cwd = dir) {
		const at = (name: string) => join(dir, name);
		return {
			cwd,
			paths: {
				requestPath: at("request.json"),
				cancelPath: at("cancel.json"),
				leasePath: at("lease.json"),
				resultPath: at("result.json"),
			},
		};
	}

	it("clears what an earlier wrap-up under the same id left", async () => {
		// A cancellation stops the new supervisor on arrival, and a
		// result reads to a collect as this wrap-up's answer.
		const dir = await tempDir();
		const script = join(dir, "supervisor.mjs");
		await writeFile(script, "");
		const asked = await wrapUpIn(dir);
		for (const left of ["cancelPath", "leasePath", "resultPath"] as const)
			await writeFile(asked.paths[left], "{}");

		await handOver(asked, script);

		expect(await exists(asked.paths.cancelPath), "cancel.json").toBe(false);
		expect(await exists(asked.paths.leasePath), "lease.json").toBe(false);
		expect(await exists(asked.paths.resultPath), "result.json").toBe(false);
		expect(
			JSON.parse(await readFile(asked.paths.requestPath, "utf8")).cwd,
		).toBe(dir);
	});

	it("takes its request back when its supervisor cannot start", async () => {
		// Left behind, the request would hold a collect for a wrap-up
		// that never ran.
		const dir = await tempDir();
		const asked = await wrapUpIn(dir, join(dir, "gone"));

		await expect(
			handOver(asked, join(dir, "supervisor.mjs")),
		).rejects.toThrow();

		expect(
			await exists(asked.paths.requestPath),
			"the request of a wrap-up that never started is gone",
		).toBe(false);
	});
});

describe("who sends a wrap-up", () => {
	async function request(orphaned: boolean) {
		const stateDir = await tempDir();
		const { paths } = await told(
			{ piInstall: { node: process.execPath, entry: "pi.js" }, stateDir },
			{
				args: [],
				cwd: stateDir,
				runId: "run",
				reviewerId: "slow",
				wrapUp: {
					reviewerId: "slow+wrapup",
					args: ["--session", "-", "say"],
					timeoutMs: 1500,
					idleTimeoutMs: 1500,
				},
			},
			orphaned,
		);
		return JSON.parse(await readFile(paths.requestPath, "utf8"));
	}

	it("is the supervisor, for a run nobody waits for", async () => {
		const asked = await request(true);

		expect(asked.wrapUp.args).toEqual(["pi.js", "--session", "-", "say"]);
	});

	it("is the waiting caller otherwise, so its supervisor is told none", async () => {
		// Both sending one would ask the reviewer twice.
		expect((await request(false)).wrapUp).toBeUndefined();
	});
});

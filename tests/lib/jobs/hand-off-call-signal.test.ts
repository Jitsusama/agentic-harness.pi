/**
 * A handed-off call's commands follow its job, not the call.
 *
 * A review provider is built once and runs its commands through an
 * exec that reads the call's signal when each command starts. A World
 * cut a round began before its minute was up read the tool call's own
 * signal, so the cut was stopped when that fired after the round had
 * moved to a job, and the round reported the cut as failed.
 */

import {
	type AgentToolResult,
	createEventBus,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { withCallSignal } from "../../../lib/core/exec/call-signal.ts";
import type { ExecResult } from "../../../lib/core/exec/exec.ts";
import { EXIT_ABORTED, spawnExec } from "../../../lib/core/exec/spawn.ts";
import { runOrHandOff } from "../../../lib/jobs/hand-off.ts";
import { announceJobHost, jobStopReason } from "../../../lib/jobs/index.ts";

/** The conversation calling: one per test process, as each pi has its own. */
const SESSION = `test-${process.pid}`;

/** How long a command gets to show it is still running, or has ended. */
const SETTLES_WITHIN_MS = 2_000;

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

/** A job host whose jobs can be stopped by the test. */
function stoppableHost() {
	const bus = createEventBus();
	const jobs: AbortController[] = [];
	disposers.push(
		announceJobHost(bus, {
			start() {
				const controller = new AbortController();
				jobs.push(controller);
				return {
					id: `j${jobs.length}`,
					signal: controller.signal,
					finish: () => {},
					onDelivered: () => {},
					withdraw: () => false,
				};
			},
		}),
	);
	return { bus, jobs };
}

/** What a run settled as within a short wait, or that it had not. */
function within<T>(running: Promise<T>): Promise<T | "still running"> {
	return Promise.race([
		running,
		new Promise<"still running">((resolve) =>
			setTimeout(() => resolve("still running"), SETTLES_WITHIN_MS),
		),
	]);
}

const done: AgentToolResult<undefined> = {
	content: [{ type: "text", text: "done" }],
	details: undefined,
};

/** A command's run ended at once, or "still running" when no stop reached it. */
function stopped(
	command: Promise<ExecResult>,
): Promise<number | "still running"> {
	return within(command).then((result) =>
		result === "still running" ? result : result.code,
	);
}

/**
 * A tool call, run as the review tools run theirs, whose work starts a
 * command through an exec made before the call, and moves to a job
 * after `afterMs`, or starts a second one once it has, as `after` says.
 * Answers once the command has started, with its run, the call's, and
 * its stops; every stop is pulled once the test ends, so a red run
 * leaves no `sleep` behind.
 */
async function handedOffCommand(afterMs = 10, after = false) {
	const { bus, jobs } = stoppableHost();
	// Built outside any call, as a provider's exec is.
	const exec = spawnExec();
	const call = new AbortController();
	disposers.push(() => {
		call.abort();
		for (const job of jobs) job.abort(jobStopReason("agent"));
	});
	// Held in a box, since a promise resolved with a promise waits for it.
	let started: (command: { run: Promise<ExecResult> }) => void = () => {};
	const command = new Promise<{ run: Promise<ExecResult> }>((resolve) => {
		started = resolve;
	});
	let movedOn: () => void = () => {};
	const moved = new Promise<void>((resolve) => {
		movedOn = resolve;
	});
	const answered = withCallSignal(call.signal, () =>
		runOrHandOff({
			kind: "review",
			label: "council on a change",
			noun: "background round",
			stopping: (jobId) => `Stop it with ${jobId}.`,
			filePrefix: "pi-test",
			session: SESSION,
			nested: false,
			signal: call.signal,
			onUpdate: undefined,
			bus,
			run: async () => {
				if (after) await moved;
				const running = exec("sleep", ["30"]);
				started({ run: running });
				await running;
				return done;
			},
			afterMs,
		}),
	);
	if (after) {
		await answered;
		movedOn();
	}
	const running = (await command).run;
	const job = () => {
		expect(jobs, "the call moved to one job").toHaveLength(1);
		const [only] = jobs;
		if (!only) throw new Error("no job was started");
		return only;
	};
	return { command: running, call, job, answered };
}

describe("a command a handed-off call started", () => {
	it("outlives the call's signal firing", async () => {
		const { command, call, job, answered } = await handedOffCommand();
		await answered;
		call.abort();

		expect(await within(command)).toBe("still running");
		job().abort(jobStopReason("agent"));
		expect(await stopped(command)).toBe(EXIT_ABORTED);
	}, 10_000);

	it("stops with its job", async () => {
		const { command, job, answered } = await handedOffCommand();
		await answered;
		job().abort(jobStopReason("person"));

		expect(await stopped(command)).toBe(EXIT_ABORTED);
	}, 10_000);

	it("stops with Escape before the call moves", async () => {
		const { command, call } = await handedOffCommand(60_000);
		call.abort();

		const result = await within(command);
		expect(result === "still running" ? result : result.code).toBe(
			EXIT_ABORTED,
		);
		expect(
			result === "still running" ? result : result.stderr,
			"the abort names no reason",
		).toContain("aborted: ");
	}, 10_000);

	it("stops with its job when begun after the call moved", async () => {
		const { command, job } = await handedOffCommand(10, true);
		job().abort(jobStopReason("person"));

		const result = await within(command);
		expect(result === "still running" ? result : result.code).toBe(
			EXIT_ABORTED,
		);
		expect(
			result === "still running" ? result : result.stderr,
			"the abort doesn't say the job stopped it",
		).toContain('"jobStop":"person"');
	}, 10_000);
});

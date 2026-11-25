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

/**
 * A tool call, run as the review tools run theirs, whose work starts a
 * command through an exec made before the call, and moves to a job
 * almost at once. Answers with the command's run and its stops.
 */
async function handedOffCommand() {
	const { bus, jobs } = stoppableHost();
	// Built outside any call, as a provider's exec is.
	const exec = spawnExec();
	const call = new AbortController();
	let command: Promise<ExecResult> | undefined;
	await withCallSignal(call.signal, () =>
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
				command = exec("sleep", ["30"]);
				await command;
				return done;
			},
			afterMs: 10,
		}),
	);
	if (!command) throw new Error("the work never started its command");
	return { command, call, job: () => jobs[0] };
}

describe("a command a handed-off call started", () => {
	it("outlives the call's signal firing", async () => {
		const { command, call, job } = await handedOffCommand();
		call.abort();

		expect(await within(command)).toBe("still running");
		job()?.abort(jobStopReason("agent"));
		await command;
	}, 10_000);

	it("stops with its job", async () => {
		const { command, job } = await handedOffCommand();
		job()?.abort(jobStopReason("person"));

		const result = await within(command);
		expect(result === "still running" ? result : result.code).toBe(
			EXIT_ABORTED,
		);
	}, 10_000);
});

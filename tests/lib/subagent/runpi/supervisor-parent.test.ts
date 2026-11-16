/**
 * The parent over its supervisor: how it starts one and settles on its
 * result, the leash and timeouts it hands down, what it keeps of a
 * stopped reviewer, the grace it allows the supervisor's shutdown, and
 * what it does about a supervisor that never reports or will not stop.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReviewerArtifactsStore } from "../../../../lib/subagent/artifacts.ts";
// biome-ignore lint/correctness/useImportExtensions: Biome reads the .d.mts beside this .mjs as the module and asks for .mjs.mts, a file that doesn't exist.
import { STDIO_GRACE_MS } from "../../../../lib/subagent/runpi/grace.mjs";
import {
	createSupervisorRunPi as createRealSupervisorRunPi,
	parentGraceMs,
} from "../../../../lib/subagent/runpi/supervisor.ts";
import { makeFakeChild } from "./fake-child.ts";
import {
	ANSWERED,
	artifactsOf,
	createSupervisorRunPi,
	fakeSupervisor,
	runOnFake,
	TEST_TIMEOUT_MS,
	tempStateDir,
} from "./supervised.ts";

// Slack for spawning, not a work budget: TEST_TIMEOUT_MS says why.
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

describe("createSupervisorRunPi: the parent over its supervisor", () => {
	it("spawns the node supervisor and returns the durable result", async () => {
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		const calls: Array<{
			command: string;
			args: readonly string[];
			cwd: string;
		}> = [];
		const answering = fakeSupervisor(stateDir, fake, (request) => ({
			...ANSWERED,
			warnings: ["from-result"],
			artifacts: artifactsOf(request),
		}));
		const runPi = runOnFake(stateDir, {
			spawn: (command, args, options) => {
				calls.push({ command, args, cwd: String(options.cwd) });
				return answering(command, args, options);
			},
		});

		const result = await runPi({
			args: ["--mode", "json", "-p", "prompt"],
			cwd: "/tmp/wt",
			runId: "run-1",
			reviewerId: "fast",
		});

		expect(calls).toEqual([
			{
				command: "node",
				args: [
					"/pkg/reviewer-supervisor.mjs",
					expect.stringContaining("request.json"),
				],
				cwd: "/tmp/wt",
			},
		]);
		expect(result).toMatchObject({
			exitCode: 0,
			finalAssistantText: "done",
			warnings: ["from-result"],
		});
		expect(result.stdout).toBeUndefined();
	});

	it("honours the leash it was given, rather than its own floor", async () => {
		// The supervisor used to raise any requested timeout to a
		// forty-five minute floor with Math.max, so a caller asking for
		// a short leash silently got the floor. The parent defaults to
		// the same numbers, so it protected nothing and only overruled
		// people.
		//
		// It also made this script's own watchdog unreachable in a test,
		// and that is what cost an afternoon: when CI failed with the
		// supervisor still "running" at the parent's deadline, the
		// supervisor had nothing of its own to say, because nothing of
		// its own could ever fire. The parent killed it and reported
		// silence, one run in three.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "mute.mjs");
		// A reviewer that never says anything and never exits.
		await writeFile(childPath, "setTimeout(() => {}, 600000);\n");

		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: 3_000,
			timeoutMs: 30_000,
			// Well past the leash, so the supervisor is what gives up.
			supervisorGraceMs: 30_000,
		});

		const started = Date.now();
		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "mute",
		});

		// The supervisor's own idle watchdog, not the parent's deadline.
		expect(Date.now() - started).toBeLessThan(20_000);
		expect(result.exitCode).not.toBe(0);
		expect((result.warnings ?? []).join(" ")).toMatch(/idle/i);
	});

	it("finishes on the terminal event, not on the process", async () => {
		// The supervisor writes its result file and then says terminal,
		// in that order, so by the time the parent hears it there is
		// nothing left to wait for. Waiting for the process to exit
		// instead made every answer depend on the operating system
		// telling us about a process, when the contract was always a
		// file, and every hang this file has had came through that gap.
		//
		// So the fake below finishes properly and then wedges: no exit,
		// no close, pipes still open. That is the shape CI kept hitting.
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		const runPi = runOnFake(stateDir, {
			// Generous, so a pass cannot be the backstop firing early.
			timeoutMs: 120_000,
			// Written, announced, and then nothing: deliberately no end() on
			// stdout and no exit or close event at all.
			spawn: fakeSupervisor(
				stateDir,
				fake,
				(request) => ({
					...ANSWERED,
					finalAssistantText: "finished, then wedged",
					artifacts: artifactsOf(request),
				}),
				{ wedge: true },
			),
		});

		const started = Date.now();
		const result = await runPi({
			args: [],
			cwd: "/tmp/wt",
			runId: "run-terminal",
			reviewerId: "wedges-after-finishing",
		});

		expect(result.finalAssistantText).toBe("finished, then wedged");
		expect(result.exitCode).toBe(0);
		// Settled by the terminal file rather than by the backstop, and
		// that is all this can say: the fake child never emits "exit",
		// so no pipe drain is ever armed here and a bound in terms of
		// the drain would name a timer this path does not create.
		//
		// The bound is scheduler slack, so it is written as slack. It
		// asked for five seconds, which is a spawn and two atomic writes
		// away from a loaded machine, and duly failed twice under
		// full-suite load. What it has to rule out is a run that waited
		// out the 120s backstop above.
		expect(Date.now() - started).toBeLessThan(30_000);
	});

	it("forwards supervisor activity events to the live progress hook", async () => {
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		const events: Record<string, unknown>[] = [];
		const runPi = runOnFake(stateDir, {
			spawn: fakeSupervisor(stateDir, fake, () => ANSWERED, {
				say: [{ type: "activity", activity: "reading x" }],
			}),
		});

		await runPi({
			args: [],
			cwd: "/tmp",
			runId: "run",
			reviewerId: "fast",
			onEvent: (event) => events.push(event),
		});

		expect(events).toContainEqual(
			expect.objectContaining({ type: "activity", activity: "reading x" }),
		);
	});

	it("keeps what a stopped reviewer had written", async () => {
		// The whole loss, reproduced without a model. A reviewer taken
		// away at its budget never sends message_end, so a supervisor
		// watching only for that reports an empty answer and everything
		// the reviewer had written is gone. Verified against a live
		// child too: 2224 characters kept where there had been none.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		const streaming = (text: string) =>
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					partial: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "still going" },
							{ type: "text", text },
						],
					},
				},
			});
		// Streams an answer it never finishes, then holds the loop open
		// so only the budget can end it.
		await writeFile(
			childPath,
			`process.stdout.write(${JSON.stringify(`${streaming('{"findings": [')}\n`)});\n` +
				`process.stdout.write(${JSON.stringify(
					`${streaming('{"findings": [{"subject": "a real finding"}')}\n`,
				)});\n` +
				"setInterval(() => {}, 1000);",
		);

		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: 1_000,
			timeoutMs: 1_000,
			killGraceMs: 500,
			supervisorGraceMs: 30_000,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "stopped",
		});

		expect(result.finalAssistantText).toBe(
			'{"findings": [{"subject": "a real finding"}',
		);
		expect(result.exitCode).not.toBe(0);
	});

	it("does not accuse an exited reviewer of never starting", async () => {
		// Two rungs after a stop that were written as though independent:
		// the kill escalates at the kill grace, and the answer of last
		// resort fires at twice it, saying the child may never have
		// started. The drain, armed when the child does exit, owned the
		// rest of the shutdown only while it happened to be shorter than
		// the kill grace. Nothing said so and nothing checked it, so
		// raising the drain to the value already measured as necessary
		// silently handed every stopped run to the last resort, which
		// then reported a false diagnosis about a reviewer that had
		// provably exited seconds earlier.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		// Two halves, and both are needed. It ignores the polite signal
		// and holds the loop, so it is still there to be killed and its
		// exit lands after the kill grace; and it leaves a grandchild
		// holding the pipes outside its process group, so "close" never
		// arrives and the drain is what has to end the run. That second
		// half is what the file elsewhere calls ordinary reviewer
		// behaviour, and without it "close" settles everything long
		// before either rung matters.
		await writeFile(
			childPath,
			[
				'import { spawn } from "node:child_process";',
				'spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"],',
				'  { stdio: "inherit", detached: true }).unref();',
				'process.on("SIGTERM", () => {});',
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);

		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: 1_000,
			timeoutMs: 1_000,
			// The default, which is where the two rungs came level.
			killGraceMs: 5_000,
			supervisorGraceMs: 60_000,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "stopped-but-exited",
		});

		expect(result.warnings?.join(" ") ?? "").not.toContain(
			"may not have started at all",
		);
	}, 90_000);

	it("bills a stopped turn once, in the copy that actually runs", async () => {
		// The child script keeps its own copy of the billing rule, and it
		// is the one production uses. It had no test, so it was possible
		// to fix the parser, watch the suite go green, and ship the bug.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		const running = (text: string) =>
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					partial: {
						role: "assistant",
						content: [{ type: "text", text }],
						usage: {
							input: 100,
							output: 50,
							totalTokens: 150,
							cost: { total: 7 },
						},
					},
				},
			});
		await writeFile(
			childPath,
			`process.stdout.write(${JSON.stringify(`${running("one")}\n`)});\n` +
				`process.stdout.write(${JSON.stringify(`${running("one two")}\n`)});\n` +
				`process.stdout.write(${JSON.stringify(`${running("one two three")}\n`)});\n` +
				"setInterval(() => {}, 1000);",
		);

		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: 1_000,
			timeoutMs: 1_000,
			killGraceMs: 500,
			supervisorGraceMs: 30_000,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "billed",
		});

		// Once for the turn, not once per update and not nothing at all.
		expect(result.usage?.cost.total).toBe(7);
		expect(result.finalAssistantText).toBe("one two three");
	});

	it("prefers per-call timeout overrides over config defaults", async () => {
		// Long-running personas (gsperf bench runs, gcloud
		// deploys) need to push the idle and wall-clock
		// ceilings up without nudging the global default that
		// short-lived siblings benefit from. The runner reads
		// per-call overrides off the `RunPi` opts and writes
		// them into the supervisor request JSON, where the
		// node supervisor honours them on each run.
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		let captured: { timeoutMs?: number; idleTimeoutMs?: number } = {};
		const runPi = runOnFake(stateDir, {
			idleTimeoutMs: 1_000,
			timeoutMs: 2_000,
			spawn: fakeSupervisor(stateDir, fake, (request) => {
				captured = {
					timeoutMs: request.timeoutMs,
					idleTimeoutMs: request.idleTimeoutMs,
				};
				return ANSWERED;
			}),
		});

		await runPi({
			args: [],
			cwd: "/tmp",
			runId: "run",
			reviewerId: "long",
			timeoutMs: 45 * 60 * 1000,
			idleTimeoutMs: 15 * 60 * 1000,
		});

		expect(captured).toEqual({
			timeoutMs: 45 * 60 * 1000,
			idleTimeoutMs: 15 * 60 * 1000,
		});
	});

	it("falls back to config-level timeouts when the call omits them", async () => {
		// Per-call overrides are opt-in. When absent the
		// runner's configured defaults win; when those are
		// also absent the module-level constants apply. This
		// keeps existing callers (pr-workflow, the fleet tool
		// without per-job overrides) on their current
		// behaviour.
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		let captured: { timeoutMs?: number; idleTimeoutMs?: number } = {};
		const runPi = runOnFake(stateDir, {
			idleTimeoutMs: 7_777,
			timeoutMs: 8_888,
			spawn: fakeSupervisor(stateDir, fake, (request) => {
				captured = {
					timeoutMs: request.timeoutMs,
					idleTimeoutMs: request.idleTimeoutMs,
				};
				return ANSWERED;
			}),
		});

		await runPi({
			args: [],
			cwd: "/tmp",
			runId: "run",
			reviewerId: "default",
		});

		expect(captured).toEqual({ timeoutMs: 8_888, idleTimeoutMs: 7_777 });
	});

	it("gives up on a supervisor that will not stop, and stops its child itself", async () => {
		// Cancelling used to be a request and nothing more: the supervisor
		// was asked, and only its answer or the whole run's deadline, most
		// of an hour away, could settle the wait. A supervisor too wedged
		// to act on the signal held Escape hostage for that hour and left
		// its child, in a group of its own, running after it.
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		const group = nodeSpawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ detached: true, stdio: "ignore" },
		);
		const groupId = group.pid ?? 0;
		const gone = new Promise((resolve) => group.once("exit", resolve));
		let markSpawned: () => void = () => {};
		const spawned = new Promise<void>((resolve) => {
			markSpawned = resolve;
		});
		const runPi = runOnFake(stateDir, {
			supervisorGraceMs: 300,
			spawn: () => {
				markSpawned();
				return fake.process();
			},
		});
		const controller = new AbortController();
		const promise = runPi({
			args: [],
			cwd: "/tmp",
			runId: "run",
			reviewerId: "wedged",
			signal: controller.signal,
		});
		await spawned;
		fake.stdout.write(
			`${JSON.stringify({ type: "started", pid: groupId, pgid: groupId })}\n`,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));

		controller.abort();
		const outcome = await Promise.race([
			promise.then((result) => ({ settled: true as const, result })),
			new Promise<{ settled: false }>((resolve) =>
				setTimeout(() => resolve({ settled: false }), 5_000),
			),
		]);
		const groupStopped = await Promise.race([
			gone.then(() => true),
			new Promise<boolean>((resolve) =>
				setTimeout(() => resolve(false), 1_000),
			),
		]);
		if (!groupStopped) process.kill(-groupId, "SIGKILL");

		expect(outcome).toMatchObject({ settled: true });
		expect(fake.kills).toEqual(["SIGTERM", "SIGKILL"]);
		expect(
			groupStopped,
			"the child's process group is gone within a second",
		).toBe(true);
		if (outcome.settled) {
			expect(outcome.result.exitCode).toBe(130);
			expect(outcome.result.warnings?.join(" ")).toMatch(
				/did not stop within 300ms of being cancelled/,
			);
		}
	});

	it("writes a durable reviewer cancellation request on abort", async () => {
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		let markSpawned: () => void = () => {};
		const spawned = new Promise<void>((resolve) => {
			markSpawned = resolve;
		});
		const runPi = runOnFake(stateDir, {
			spawn: () => {
				markSpawned();
				return fake.process();
			},
		});
		const controller = new AbortController();

		const promise = runPi({
			args: [],
			cwd: "/tmp",
			runId: "run",
			reviewerId: "fast",
			signal: controller.signal,
		});
		await spawned;
		fake.child.kill = (signal) => {
			fake.kills.push(signal);
			queueMicrotask(() => fake.emitClose(143));
			return true;
		};
		controller.abort();
		await promise;

		const cancel = await new ReviewerArtifactsStore(stateDir).readJson(
			new ReviewerArtifactsStore(stateDir).paths("run", "fast").cancelPath,
		);
		expect(cancel).toMatchObject({ reason: "parent-abort" });
		expect(fake.kills).toContain("SIGTERM");
	});
});

describe("the parent's grace over the supervisor's own budget", () => {
	// The rung that decides whether the supervisor reports its own
	// verdict or is killed mid-sentence. After its last watchdog fires
	// it still signals the child, waits out the kill grace, escalates,
	// drains pipes and then writes its result, and all of that has to
	// fit inside the parent's grace.
	it("leaves room for the shutdown the supervisor actually does", () => {
		// The drain in this sum is the supervisor's own constant,
		// imported rather than mirrored. It was a copy kept in step by
		// hand, under a comment admitting these assertions are one-sided
		// and a stale copy would go on passing while documenting the
		// wrong number. The same reasoning held for the two in the
		// source, and they were two seconds apart.
		// A five second kill grace plus the pipe draining left three
		// seconds for every atomic write in finish under the old flat
		// ten. That held on an idle machine and lost about one CI run in
		// five.
		const grace = parentGraceMs(5_000);

		expect(grace).toBeGreaterThan(5_000 + STDIO_GRACE_MS);
		// Not merely greater: the surplus is the whole point, and a
		// margin of seconds is what was already there and failing.
		expect(grace - (5_000 + STDIO_GRACE_MS)).toBeGreaterThanOrEqual(10_000);
	});

	it("grows with a kill grace it is given", () => {
		// A caller who gives the child longer to die has not thereby
		// given the supervisor less time to speak.
		expect(parentGraceMs(30_000)).toBeGreaterThan(parentGraceMs(5_000));
		expect(parentGraceMs(30_000) - 30_000).toBeGreaterThanOrEqual(10_000);
	});

	it("honours a grace it was handed, however short", () => {
		// The backstop's own tests need it to fire promptly, and a caller
		// naming a number has said what they want.
		expect(parentGraceMs(5_000, 500)).toBe(500);
	});
});

describe("a supervisor that never reports", () => {
	it("stops waiting instead of hanging the run for ever", async () => {
		// Every other way out of runPi is an event from the child. A
		// supervisor that starts and then wedges before installing its
		// own watchdog fires none of them, so the promise never
		// settled and a fleet run waited for ever on a reviewer that
		// would never answer.
		//
		// Substituting spawn for a process that ignores its
		// instructions and sleeps is the only way to reach that state
		// deliberately: a working supervisor cannot be asked to wedge.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(childPath, "");

		// The real factory, deliberately. This is the test of the
		// give-up path itself, so the wrapper that turns giving up into a
		// thrown postmortem would swallow exactly what is being asserted.
		const runPi = createRealSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: 500,
			timeoutMs: 500,
			// The default grace is ten seconds of deliberate waiting,
			// which is the right thing in production and a bad neighbour
			// in a suite. What is under test is that the deadline fires
			// at all, not how long it is.
			supervisorGraceMs: 500,
			spawn: ((_bin: string, _args: readonly string[]) =>
				nodeSpawn(process.execPath, [
					"-e",
					"setTimeout(() => {}, 120000)",
				])) as never,
		});

		const started = Date.now();
		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "wedged",
		});

		// Well inside the file's own 60s budget, and it says why.
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result.exitCode).not.toBe(0);
		expect((result.warnings ?? []).join(" ")).toContain("never reported");
	});

	it("says how stale its last word was, not just what it said", async () => {
		// The datum that separates the two ways this fails in CI, where
		// it has never been reproducible. A supervisor starved of CPU
		// writes progress right up to the deadline, so its last word is
		// seconds old. One that wedged early wrote once and stopped, so
		// its last word is as old as the whole wait. Reporting the state
		// alone cannot tell them apart, and both read as "running".
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(childPath, "");

		// A supervisor that reports once and then wedges, which is the
		// shape CI shows: progress on disk saying "running", and nothing
		// after it. The real one cannot be asked to do this, so its
		// first write is staged here and the process then sleeps.
		const paths = new ReviewerArtifactsStore(stateDir).paths("run", "wedged");
		await mkdir(paths.reviewerDir, { recursive: true });
		await writeFile(paths.progressPath, JSON.stringify({ state: "running" }));

		// The real factory, for the same reason as the test above.
		const runPi = createRealSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: 500,
			timeoutMs: 500,
			supervisorGraceMs: 500,
			spawn: ((_bin: string, _args: readonly string[]) =>
				nodeSpawn(process.execPath, [
					"-e",
					"setTimeout(() => {}, 120000)",
				])) as never,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "wedged",
		});

		const said = (result.warnings ?? []).join(" ");
		expect(said).toContain("progress says");
		// The age is the point. Without it both failure modes read as
		// "running" and the CI log cannot say which one happened.
		expect(said).toMatch(/progress says [^;]*, last written \d+ms ago/);
	});
});

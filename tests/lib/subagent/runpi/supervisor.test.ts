import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ReviewerArtifactsStore } from "../../../../lib/subagent/artifacts.js";
import {
	createSupervisorRunPi,
	parentGraceMs,
} from "../../../../lib/subagent/runpi/supervisor.js";
import type { RunPiResult } from "../../../../lib/subagent/subagent.js";

// Every test here spawns the real node supervisor, sometimes two
// process levels deep. Under parallel suite load the OS can take tens
// of seconds just to schedule and start those processes, which blows
// the 5s default test timeout and shows up as flaky. The timeout here
// is slack for that scheduling latency, not a real work budget: each
// run pins the supervisor's own idle and wall-clock timeouts far
// lower, so a genuinely wedged run still fails fast. Paired with the
// worker cap in vitest.config.ts, this keeps the file green under a
// saturated fork pool. Set at collection time, since a beforeAll runs
// after the tests are already registered with the default.
//
// This file carried a retry for a while, for a CI-only hang I could
// not reproduce: not on macOS, not with the machine saturated by
// twelve spinners, and not in a two-cpu Linux container running the
// same suite. What closed it was giving up on reproducing the
// environment and removing the dependency instead. The parent used
// to wait for the supervisor's process to exit, so every answer
// depended on the operating system reporting a process, when the
// contract was always a file the supervisor writes before it says
// it is done. It now settles on that. A supervisor that finishes
// and then wedges, which is what CI looked like, no longer costs
// the caller anything, and the test below reproduces that shape
// deliberately.
// The timeout ladder matters more than any rung on it. The
// supervisor gives up first and says which watchdog fired, then the
// parent gives up and reports its post-mortem, and only then does
// vitest give up, which reports nothing but a duration. CI failed
// at 60006ms on a run that had plenty left to say, because the rungs
// were in the other order.
vi.setConfig({ testTimeout: 150_000 });

interface FakeChild {
	stdout: Readable;
	stderr: Readable;
	stdin?: Writable;
	on(event: "close", listener: (code: number | null) => void): FakeChild;
	once(event: "close", listener: (code: number | null) => void): FakeChild;
	once(event: "error", listener: (err: Error) => void): FakeChild;
	kill(signal?: NodeJS.Signals): boolean;
}

function makeFakeChild(): {
	child: FakeChild;
	emitClose: (code: number | null) => void;
	stdout: PassThrough;
	stderr: PassThrough;
	kills: Array<NodeJS.Signals | undefined>;
} {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const kills: Array<NodeJS.Signals | undefined> = [];
	const handlers: {
		close: ((code: number | null) => void)[];
		error: ((err: Error) => void)[];
	} = {
		close: [],
		error: [],
	};
	const child: FakeChild = {
		stdout,
		stderr,
		on(event, listener) {
			if (event === "close") handlers.close.push(listener);
			return child;
		},
		once(event, listener) {
			if (event === "close")
				handlers.close.push(listener as (code: number | null) => void);
			if (event === "error")
				handlers.error.push(listener as (err: Error) => void);
			return child;
		},
		kill(signal) {
			kills.push(signal);
			return true;
		},
	};
	return {
		child,
		emitClose: (code) => {
			for (const handler of handlers.close) handler(code);
		},
		stdout,
		stderr,
		kills,
	};
}

async function tempStateDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pr-runpi-supervisor-"));
}

/**
 * Assert a run succeeded, and say what it reported when it did not.
 *
 * `expect(result.exitCode).toBe(0)` prints "expected 1 to be +0"
 * and throws away the warnings, which is where the supervisor
 * explains itself. On a machine I can rerun that is merely
 * annoying; on CI, where these tests fail and here they do not, it
 * is the whole difference between evidence and another rerun.
 */
/**
 * What these tests allow a nested spawn, rather than what they
 * expect it to need.
 *
 * These used to pin ten seconds, which was meaningless while the
 * supervisor raised anything shorter than forty-five minutes to its
 * floor, and dangerous the moment that floor became a default: a
 * doubly-nested node spawn on a loaded four-core runner can take
 * longer than ten seconds to get going, and CI failed about one run
 * in three with the supervisor still reporting "running". None of
 * these tests are about how long a run may take, so the number only
 * has to be beyond suspicion.
 *
 * It also has to leave room above it. This plus the parent's grace
 * must stay under the file's test timeout, or vitest kills the run
 * before either watchdog can explain itself, which is how the same
 * fault came back reported as "60006ms" and nothing else.
 *
 * Forty seconds was still not enough. CI then failed at 50015ms,
 * which is this leash plus the parent's grace, on a test whose child
 * prints two lines and exits. A doubly-nested node spawn on a
 * shared runner is simply slower than I keep assuming, so the
 * number is now two minutes: far past anything these tests need,
 * and still under the timeout above it. If a run ever crosses this,
 * the supervisor's own watchdog reports it rather than vitest
 * reporting a duration.
 */
const GENEROUS_MS = 120_000;

function expectRan(result: RunPiResult): void {
	if (result.exitCode !== 0) {
		throw new Error(
			`run failed with exit ${result.exitCode}\n` +
				`warnings: ${JSON.stringify(result.warnings, null, 1)}\n` +
				`stderr: ${result.stderrTail ?? "(none)"}\n` +
				`text: ${result.finalAssistantText || "(none)"}`,
		);
	}
}

describe("createSupervisorRunPi", () => {
	it("runs the real supervisor script against a JSON-emitting child", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"supervised"}],usage:{input:1,output:2,totalTokens:3,cost:{total:0.01}}}})+"\\n");`,
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "fast",
		});

		expectRan(result);
		expect(result.finalAssistantText).toBe("supervised");
		expect(result.usage?.tokens.total).toBe(3);
		expect(result.artifacts?.resultPath).toContain("result.json");
	});
	it("sets the child's PI_PACKAGE_DIR to the pinned package dir", async () => {
		// End-to-end proof of the mid-session-upgrade fix: the
		// child echoes its own PI_PACKAGE_DIR, and it must equal
		// the immutable store path the parent pinned, not whatever
		// stale value the parent's environment carried.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:String(process.env.PI_PACKAGE_DIR)}]}})+"\\n");`,
		);
		const pinned = "/nix/store/pinned-pi-0.80.7/lib/node_modules/pi-monorepo";
		const runPi = createSupervisorRunPi({
			piInstall: {
				node: process.execPath,
				entry: childPath,
				packageDir: pinned,
			},
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		// Set a conflicting parent value so the assertion proves the
		// override beats inheritance, not merely that the variable is
		// present. This is the deleted-symlink path the fix targets.
		const previous = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = "/Users/x/.pi/pkg/pi-0.80.7-deleted";
		let result: Awaited<ReturnType<typeof runPi>>;
		try {
			result = await runPi({
				args: [],
				cwd: stateDir,
				runId: "run",
				reviewerId: "fast",
			});
		} finally {
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}

		expectRan(result);
		expect(result.finalAssistantText).toBe(pinned);
	});

	it("persists the reviewer session and reports the minted session path", async () => {
		// The supervisor swaps --no-session for --session-dir
		// pointing at a private per-reviewer directory, then
		// discovers the session file pi minted there so a
		// dropped reviewer can be resumed. The fake child reads
		// its own --session-dir arg and writes a session file,
		// standing in for pi's session writer.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "session-child.mjs");
		await writeFile(
			childPath,
			[
				`import { mkdirSync, writeFileSync } from "node:fs";`,
				`const i = process.argv.indexOf("--session-dir");`,
				`if (i === -1) { process.exit(3); }`,
				`const dir = process.argv[i + 1];`,
				`mkdirSync(dir, { recursive: true });`,
				`writeFileSync(dir + "/2026-01-01T00-00-00-000Z_abc.jsonl", "{}\\n");`,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}})+"\\n");`,
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		const result = await runPi({
			args: ["--mode", "json", "--no-session", "-p", "prompt"],
			cwd: stateDir,
			runId: "run",
			reviewerId: "sessioned",
			persistSession: true,
		});

		expect(result.artifacts?.sessionDir).toContain("session");
		expect(result.artifacts?.sessionPath).toContain(".jsonl");
		const sessionPath = result.artifacts?.sessionPath;
		if (!sessionPath) throw new Error("missing session path");
		expect((await stat(sessionPath)).isFile()).toBe(true);
	});

	it("stays ephemeral when persistSession is not requested", async () => {
		// Fleet jobs do not opt into persistence, so the
		// supervisor must leave the composed --no-session in
		// place and mint no session file. The child fails if it
		// sees --session-dir, proving the flag never reached pi.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "ephemeral-child.mjs");
		await writeFile(
			childPath,
			[
				`if (process.argv.includes("--session-dir")) { process.exit(3); }`,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}})+"\\n");`,
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		const result = await runPi({
			args: ["--mode", "json", "--no-session", "-p", "prompt"],
			cwd: stateDir,
			runId: "run",
			reviewerId: "ephemeral",
		});

		expectRan(result);
		expect(result.artifacts?.sessionPath).toBeUndefined();
	});

	it("reports a terminal model-stream error instead of a clean completion", async () => {
		// A reviewer can investigate fully and then have its
		// final turn die when the provider drops the stream.
		// The child still exits 0, so the supervisor must read
		// the errored assistant turn and surface a structured
		// error rather than reporting a silent success.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "errored-child.mjs");
		await writeFile(
			childPath,
			[
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"working"}],stopReason:"toolUse"}})+"\\n");`,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"OpenAI Responses stream ended before a terminal response event"}})+"\\n");`,
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "errored",
		});

		expect(result.error?.stopReason).toBe("error");
		expect(result.error?.message).toContain("stream ended");
		// The persisted result records the honest state, not a
		// silent "complete".
		const resultPath = result.artifacts?.resultPath;
		if (!resultPath) throw new Error("missing result path");
		const persisted = JSON.parse(await readFile(resultPath, "utf-8"));
		expect(persisted.state).toBe("errored");
	});

	it("sums usage across every message_end turn, not just the last", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "multi-turn-child.mjs");
		await writeFile(
			childPath,
			[
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"turn 1"}],usage:{input:10,output:5,totalTokens:15,cost:{total:0.20}}}})+"\\n");`,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"turn 2"}],usage:{input:20,output:7,totalTokens:27,cost:{total:0.15}}}})+"\\n");`,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"turn 3"}],usage:{input:30,output:3,totalTokens:33,cost:{total:0.04}}}})+"\\n");`,
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "multi",
		});

		expectRan(result);
		// 15 + 27 + 33 across three turns, not the final turn's 33.
		expect(result.usage?.tokens.total).toBe(75);
		// 0.20 + 0.15 + 0.04, not the final turn's 0.04.
		expect(result.usage?.cost.total).toBeCloseTo(0.39, 10);
	});
	it("captures successful verify_output calls and their canonical output", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "verified-child.mjs");
		await writeFile(
			childPath,
			[
				`const args = { stage: "council", output: { findings: [{ location: { kind: "global" }, label: "note", subject: "Verified", discussion: "Ok" }] } };`,
				`process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "verify-1", toolName: "verify_output", args }) + "\\n");`,
				`process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "verify-1", toolName: "verify_output", result: { content: [{ type: "text", text: "ok: true. 1 item passed schema for stage=council." }], details: { ok: true, count: 1 } } }) + "\\n");`,
				`process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "not json" }] } }) + "\\n");`,
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "verified",
		});

		expect(result.verification).toMatchObject({
			called: true,
			ok: true,
			stage: "council",
			count: 1,
		});
		expect(result.verification).not.toHaveProperty("output");
		expect(result.verification?.canonicalText).toBe(true);
		expect(result.finalAssistantText).toContain("Verified");
		expect(result.finalAssistantText).not.toBe("not json");
	});

	it("reads verified output out-of-band from the envelope file, past the stream and text caps", async () => {
		// The reviewer writes its validated payload to the file
		// named by SUBAGENT_VERIFY_OUTPUT_PATH and never emits
		// it on the stream. Even with the line and assistant-
		// text caps set far below the payload size, the parent
		// must recover the whole output, because it came on a
		// file rather than the capped stream. This is the ARG_MAX
		// sibling: large reviews used to be silently dropped.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "oob-child.mjs");
		const bigDiscussion = "x".repeat(4096);
		await writeFile(
			childPath,
			[
				`import { writeFileSync } from "node:fs";`,
				`const output = { findings: [{ location: { kind: "global" }, label: "issue", subject: "Big", discussion: ${JSON.stringify(bigDiscussion)} }] };`,
				`writeFileSync(process.env.SUBAGENT_VERIFY_OUTPUT_PATH, JSON.stringify({ ok: true, stage: "council", count: 1, output }));`,
				`process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\\n");`,
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
			// Both caps are far below the 4 KB payload; out-of-band
			// delivery must ignore them.
			maxLineBytes: 256,
			maxAssistantTextBytes: 256,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "oob",
		});

		expect(result.verification).toMatchObject({
			called: true,
			ok: true,
			stage: "council",
			outOfBand: true,
		});
		// The payload survives whole, in verification.output.
		const output = result.verification?.output as {
			findings: { discussion: string }[];
		};
		expect(output.findings[0].discussion).toBe(bigDiscussion);
	});

	it("captures verifier output from unkeyed tool events", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "unkeyed-verified-child.mjs");
		await writeFile(
			childPath,
			[
				`const args = { stage: "council", output: { findings: [{ location: { kind: "global" }, label: "note", subject: "Unkeyed", discussion: "Ok" }] } };`,
				`process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "verify_output", args }) + "\\n");`,
				`process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolName: "verify_output", result: { content: [{ type: "text", text: "ok: true. 1 item passed schema for stage=council." }], details: { ok: true, count: 1 } } }) + "\\n");`,
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "unkeyed",
		});

		expect(result.verification).not.toHaveProperty("output");
		expect(result.verification?.canonicalText).toBe(true);
		expect(result.finalAssistantText).toContain("Unkeyed");
	});

	it("rotates compressed event logs after the active artifact reaches its cap", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "noisy-child.mjs");
		await writeFile(
			childPath,
			[
				`for (let i = 0; i < 8; i++) { const pad = "x".repeat(120); process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path:"file-" + i + "-" + pad}})+"\\n"); await new Promise((resolve) => setTimeout(resolve, 15)); }`,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"still done"}]}})+"\\n");`,
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			maxEventBytes: 80,
			maxEventRotations: 2,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "noisy",
		});

		expectRan(result);
		expect(result.finalAssistantText).toBe("still done");
		const eventsPath = result.artifacts?.eventsPath;
		expect(eventsPath).toBeDefined();
		if (!eventsPath) throw new Error("missing events path");
		expect((await stat(eventsPath)).size).toBeGreaterThan(0);
		const eventFiles = await readdir(join(eventsPath, ".."));
		const rotations = eventFiles.filter((name) =>
			/^events\.ndjson\.\d+\.gz$/.test(name),
		);
		expect(rotations.length).toBeGreaterThan(0);
		expect(rotations.length).toBeLessThanOrEqual(2);
	});

	it("spawns the node supervisor and returns the durable result", async () => {
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		const calls: Array<{
			command: string;
			args: readonly string[];
			cwd: string;
		}> = [];
		const runPi = createSupervisorRunPi({
			piInstall: { node: "/pi/bin/node", entry: "/pi/dist/cli.js" },
			nodeBinary: "node",
			supervisorPath: "/pkg/reviewer-supervisor.mjs",
			stateDir,
			spawn: (command, args, options) => {
				calls.push({ command, args, cwd: String(options.cwd) });
				queueMicrotask(async () => {
					const request = JSON.parse(await readFile(String(args[1]), "utf-8"));
					await new ReviewerArtifactsStore(stateDir).writeJsonAtomic(
						request.paths.resultPath,
						{
							exitCode: 0,
							finalAssistantText: "done",
							warnings: ["from-result"],
							stderrTail: "",
							artifacts: {
								runDir: request.paths.runDir,
								reviewerDir: request.paths.reviewerDir,
								eventsPath: request.paths.eventsPath,
								stderrPath: request.paths.stderrPath,
								progressPath: request.paths.progressPath,
								resultPath: request.paths.resultPath,
							},
						},
					);
					fake.stdout.end(
						`${JSON.stringify({ type: "terminal", resultPath: request.paths.resultPath })}\n`,
					);
					fake.emitClose(0);
				});
				return fake.child as unknown as ChildProcess;
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
		const runPi = createSupervisorRunPi({
			piInstall: { node: "/pi/bin/node", entry: "/pi/dist/cli.js" },
			nodeBinary: "node",
			supervisorPath: "/pkg/reviewer-supervisor.mjs",
			stateDir,
			// Generous, so a pass cannot be the backstop firing early.
			timeoutMs: 120_000,
			spawn: (_command, args) => {
				queueMicrotask(async () => {
					const request = JSON.parse(await readFile(String(args[1]), "utf-8"));
					await new ReviewerArtifactsStore(stateDir).writeJsonAtomic(
						request.paths.resultPath,
						{
							exitCode: 0,
							finalAssistantText: "finished, then wedged",
							warnings: [],
							stderrTail: "",
							artifacts: {
								runDir: request.paths.runDir,
								reviewerDir: request.paths.reviewerDir,
								eventsPath: request.paths.eventsPath,
								stderrPath: request.paths.stderrPath,
								progressPath: request.paths.progressPath,
								resultPath: request.paths.resultPath,
							},
						},
					);
					// Written, announced, and then nothing: deliberately no
					// end() on stdout and no exit or close event at all.
					fake.stdout.write(
						`${JSON.stringify({
							type: "terminal",
							resultPath: request.paths.resultPath,
						})}\n`,
					);
				});
				return fake.child as unknown as ChildProcess;
			},
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
		// Promptly, rather than after the wall-clock backstop.
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("forwards supervisor activity events to the live progress hook", async () => {
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		const events: Record<string, unknown>[] = [];
		const runPi = createSupervisorRunPi({
			piInstall: { node: "/pi/bin/node", entry: "/pi/dist/cli.js" },
			nodeBinary: "node",
			supervisorPath: "/pkg/reviewer-supervisor.mjs",
			stateDir,
			spawn: (_command, args) => {
				queueMicrotask(async () => {
					const request = JSON.parse(await readFile(String(args[1]), "utf-8"));
					await new ReviewerArtifactsStore(stateDir).writeJsonAtomic(
						request.paths.resultPath,
						{
							exitCode: 0,
							finalAssistantText: "done",
							warnings: [],
							stderrTail: "",
						},
					);
					fake.stdout.write(
						`${JSON.stringify({ type: "activity", activity: "reading x" })}\n`,
					);
					fake.stdout.end(
						`${JSON.stringify({ type: "terminal", resultPath: request.paths.resultPath })}\n`,
					);
					fake.emitClose(0);
				});
				return fake.child as unknown as ChildProcess;
			},
		});

		await runPi({
			args: [],
			cwd: "/tmp",
			runId: "run",
			reviewerId: "fast",
			onEvent: (event) => events.push(event),
		});

		expect(
			events.some(
				(event) => event.type === "activity" && event.activity === "reading x",
			),
		).toBe(true);
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
		const runPi = createSupervisorRunPi({
			piInstall: { node: "/pi/bin/node", entry: "/pi/dist/cli.js" },
			nodeBinary: "node",
			supervisorPath: "/pkg/reviewer-supervisor.mjs",
			stateDir,
			idleTimeoutMs: 1_000,
			timeoutMs: 2_000,
			spawn: (_command, args) => {
				queueMicrotask(async () => {
					const request = JSON.parse(await readFile(String(args[1]), "utf-8"));
					captured = {
						timeoutMs: request.timeoutMs,
						idleTimeoutMs: request.idleTimeoutMs,
					};
					await new ReviewerArtifactsStore(stateDir).writeJsonAtomic(
						request.paths.resultPath,
						{
							exitCode: 0,
							finalAssistantText: "done",
							warnings: [],
							stderrTail: "",
						},
					);
					fake.stdout.end(
						`${JSON.stringify({ type: "terminal", resultPath: request.paths.resultPath })}\n`,
					);
					fake.emitClose(0);
				});
				return fake.child as unknown as ChildProcess;
			},
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
		const runPi = createSupervisorRunPi({
			piInstall: { node: "/pi/bin/node", entry: "/pi/dist/cli.js" },
			nodeBinary: "node",
			supervisorPath: "/pkg/reviewer-supervisor.mjs",
			stateDir,
			idleTimeoutMs: 7_777,
			timeoutMs: 8_888,
			spawn: (_command, args) => {
				queueMicrotask(async () => {
					const request = JSON.parse(await readFile(String(args[1]), "utf-8"));
					captured = {
						timeoutMs: request.timeoutMs,
						idleTimeoutMs: request.idleTimeoutMs,
					};
					await new ReviewerArtifactsStore(stateDir).writeJsonAtomic(
						request.paths.resultPath,
						{
							exitCode: 0,
							finalAssistantText: "done",
							warnings: [],
							stderrTail: "",
						},
					);
					fake.stdout.end(
						`${JSON.stringify({ type: "terminal", resultPath: request.paths.resultPath })}\n`,
					);
					fake.emitClose(0);
				});
				return fake.child as unknown as ChildProcess;
			},
		});

		await runPi({
			args: [],
			cwd: "/tmp",
			runId: "run",
			reviewerId: "default",
		});

		expect(captured).toEqual({ timeoutMs: 8_888, idleTimeoutMs: 7_777 });
	});

	it("writes a durable reviewer cancellation request on abort", async () => {
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		let markSpawned: () => void = () => {};
		const spawned = new Promise<void>((resolve) => {
			markSpawned = resolve;
		});
		const runPi = createSupervisorRunPi({
			piInstall: { node: "/pi/bin/node", entry: "/pi/dist/cli.js" },
			nodeBinary: "node",
			supervisorPath: "/pkg/reviewer-supervisor.mjs",
			stateDir,
			spawn: () => {
				markSpawned();
				return fake.child as unknown as ChildProcess;
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

describe("a reviewer that leaves something running behind it", () => {
	it("finishes instead of waiting for pipes nobody will close", async () => {
		// "close" fires when the child has exited AND its stdio has
		// closed, and those are different events. A reviewer that
		// starts a background process which inherits its pipes keeps
		// them open after it exits, so "close" never arrives and the
		// supervisor waited for ever. The wall-clock watchdog does
		// not help: it kills a child that is already dead.
		//
		// This is ordinary behaviour for a reviewer, and it hung the
		// whole run. Before the fix this test did not fail, it hung,
		// which is how it reached CI as a flake in another file.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			[
				'import { spawn } from "node:child_process";',
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"answered"}]}})+"\\n");`,
				// Inherits the pipes and outlives its parent. Short
				// enough to reap itself if anything goes wrong here.
				'spawn(process.execPath, ["-e", "setTimeout(()=>{}, 15000)"],',
				'  { stdio: "inherit" }).unref();',
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: 30_000,
			timeoutMs: 30_000,
		});

		const started = Date.now();
		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "lingering",
		});

		// The answer still arrives; only the waiting is bounded.
		expect(result.finalAssistantText).toBe("answered");
		// Well inside the 30s the supervisor was told it could take,
		// so this proves the grace path rather than a timeout.
		expect(Date.now() - started).toBeLessThan(15_000);
	});
});

describe("the parent's grace over the supervisor's own budget", () => {
	// The rung that decides whether the supervisor reports its own
	// verdict or is killed mid-sentence. After its last watchdog fires
	// it still signals the child, waits out the kill grace, escalates,
	// drains pipes and then writes its result, and all of that has to
	// fit inside the parent's grace.
	// Mirrors the supervisor's own constant. Kept in step deliberately:
	// the assertions below are one-sided, so a stale copy here would go
	// on passing while quietly documenting the wrong number.
	const STDIO_GRACE_MS = 5_000;

	it("leaves room for the shutdown the supervisor actually does", () => {
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

describe("a child that never reports a close", () => {
	it("still gets an answer out of the supervisor itself", async () => {
		// The shape CI fails in, and the one the timeout ladder is
		// supposed to make impossible. The supervisor is meant to give
		// up first and name the watchdog that fired; only if it cannot
		// does the parent's backstop kill it and report a bare duration.
		//
		// A child that ignores every signal and never closes its pipes
		// reaches that state deliberately. The supervisor has to stop
		// waiting on the child's cooperation and answer on its own.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		// Ignores SIGTERM, writes nothing, and holds the loop open, so
		// nothing the supervisor does will produce a close event short
		// of SIGKILL.
		await writeFile(
			childPath,
			`process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);`,
		);

		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			// The supervisor's own budget, kept small so its watchdog is
			// the thing under test rather than the wait for it.
			idleTimeoutMs: 1_000,
			timeoutMs: 1_000,
			killGraceMs: 500,
			// Far enough out that reaching it means the supervisor never
			// answered, which is the failure this test exists to catch.
			supervisorGraceMs: 30_000,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "deaf",
		});

		const said = (result.warnings ?? []).join(" ");
		// The supervisor's own voice, not the parent's post-mortem. This
		// passed the first time it ran, so it pins behaviour that already
		// worked rather than describing a repair: escalating to SIGKILL
		// does produce the close that lets the supervisor report. It is
		// here because that was the first hypothesis for the CI hang and
		// it deserves a guard now that it has been ruled out.
		expect(said).not.toContain("never reported within");
		expect(said).toMatch(/timed out|idle/i);
		expect(result.exitCode).not.toBe(0);
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

		const runPi = createSupervisorRunPi({
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

		const runPi = createSupervisorRunPi({
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

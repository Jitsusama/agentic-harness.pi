import type { ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ReviewerArtifactsStore } from "../../../../lib/subagent/artifacts.js";
import { createSupervisorRunPi } from "../../../../lib/subagent/runpi/supervisor.js";

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
vi.setConfig({ testTimeout: 60_000 });

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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "fast",
		});

		expect(result.exitCode).toBe(0);
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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
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

		expect(result.exitCode).toBe(0);
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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
		});

		const result = await runPi({
			args: ["--mode", "json", "--no-session", "-p", "prompt"],
			cwd: stateDir,
			runId: "run",
			reviewerId: "ephemeral",
		});

		expect(result.exitCode).toBe(0);
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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "multi",
		});

		expect(result.exitCode).toBe(0);
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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
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
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "noisy",
		});

		expect(result.exitCode).toBe(0);
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

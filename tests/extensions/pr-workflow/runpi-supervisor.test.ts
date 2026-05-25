import type { ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../extensions/pr-workflow/reviewer-artifacts.js";
import { createSupervisorRunPi } from "../../../extensions/pr-workflow/runpi-supervisor.js";

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
			binary: process.execPath,
			stateDir,
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
		});

		const result = await runPi({
			args: [childPath],
			cwd: stateDir,
			runId: "run",
			reviewerId: "fast",
		});

		expect(result.exitCode).toBe(0);
		expect(result.finalAssistantText).toBe("supervised");
		expect(result.usage?.tokens.total).toBe(3);
		expect(result.artifacts?.resultPath).toContain("result.json");
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
			binary: process.execPath,
			stateDir,
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
		});

		const result = await runPi({
			args: [childPath],
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
		expect(result.finalAssistantText).toContain("Verified");
		expect(result.finalAssistantText).not.toBe("not json");
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
			binary: process.execPath,
			stateDir,
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
		});

		const result = await runPi({
			args: [childPath],
			cwd: stateDir,
			runId: "run",
			reviewerId: "unkeyed",
		});

		expect(result.verification).not.toHaveProperty("output");
		expect(result.finalAssistantText).toContain("Unkeyed");
	});

	it("rotates compressed event logs after the active artifact reaches its cap", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "noisy-child.mjs");
		await writeFile(
			childPath,
			[
				`for (let i = 0; i < 20; i++) { process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path:"file-" + i}})+"\\n"); await new Promise((resolve) => setImmediate(resolve)); }`,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"still done"}]}})+"\\n");`,
			].join("\n"),
		);
		const runPi = createSupervisorRunPi({
			binary: process.execPath,
			stateDir,
			maxEventBytes: 80,
			maxEventRotations: 2,
			idleTimeoutMs: 10_000,
			timeoutMs: 10_000,
		});

		const result = await runPi({
			args: [childPath],
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
			binary: "pi",
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
			binary: "pi",
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

	it("writes a durable reviewer cancellation request on abort", async () => {
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		let markSpawned: () => void = () => {};
		const spawned = new Promise<void>((resolve) => {
			markSpawned = resolve;
		});
		const runPi = createSupervisorRunPi({
			binary: "pi",
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

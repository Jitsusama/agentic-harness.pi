/**
 * How a supervised child's run ends when the child does not end it
 * cleanly: a background process holding its pipes, a close that never
 * comes, an exit 0 partway through, and a supervisor that is signalled.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReviewerArtifactsStore } from "../../../../lib/subagent/artifacts.ts";
import { UNFINISHED } from "../../../../lib/subagent/reviewer-error.ts";
import type { RunPiResult } from "../../../../lib/subagent/subagent.ts";
import {
	createSupervisorRunPi,
	runChild,
	TEST_TIMEOUT_MS,
	tempStateDir,
} from "./supervised.ts";

// Slack for spawning, not a work budget: TEST_TIMEOUT_MS says why.
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

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
		// Which road it came home by, said outright rather than inferred
		// from a stopwatch. This asked for a duration, and the duration
		// is the one thing here that moves with the machine: the drain
		// went from two seconds to five, the slack went from thirteen to
		// ten, and a saturated suite spent 15.2s of it and failed a case
		// that passes alone. The distinction it is drawing is not close:
		// the grace path warns about pipes somebody left open, and the
		// timeout it rules out never warns that at all.
		expect(result.warnings?.join(" ") ?? "").toContain("left its output open");
		expect(result.state).not.toBe("timeout");
		// A backstop rather than a measurement, so a genuinely wedged
		// run still fails here instead of hanging: the supervisor was
		// told it could take thirty seconds and this must not be that.
		expect(Date.now() - started).toBeLessThan(28_000);
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

/**
 * A child that exits 0 is not a run that finished.
 *
 * Node exits when nothing holds its event loop, and until core held a
 * ref on Chrome that happened in the middle of a web read: pi left with
 * exit 0, no error and no answer, and the supervisor wrote "complete".
 * Fourteen runs on this machine ended that way. Pi says a run is over
 * with agent_end and then agent_settled, so a clean exit without either
 * is a run that stopped partway.
 */
describe("a child that exits 0 partway through its run", () => {
	/** Run the supervisor over a child that prints these events and exits 0. */
	async function supervise(
		events: readonly string[],
		options: { maxLineBytes?: number } = {},
	): Promise<{ result: RunPiResult; persisted: { state: string } }> {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			events
				.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`)
				.join("\n"),
		);
		const runPi = runChild(childPath, stateDir, {
			...options,
		});
		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "partway",
		});
		const resultPath = result.artifacts?.resultPath;
		if (!resultPath) throw new Error("missing result path");
		const persisted = JSON.parse(await readFile(resultPath, "utf-8"));
		return { result, persisted };
	}

	const said = (text: string, stopReason = "stop") =>
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason,
			},
		});
	const started = (toolCallId: string, toolName: string) =>
		JSON.stringify({ type: "tool_execution_start", toolCallId, toolName });
	const ended = (toolCallId: string, toolName: string) =>
		JSON.stringify({ type: "tool_execution_end", toolCallId, toolName });
	const AGENT_END = JSON.stringify({ type: "agent_end", messages: [] });
	const AGENT_SETTLED = JSON.stringify({ type: "agent_settled" });

	it("is unfinished when it leaves in the middle of a tool", async () => {
		const { result, persisted } = await supervise([
			said("let me look", "toolUse"),
			started("a", "web_search"),
			ended("a", "web_search"),
			started("b", "web_read"),
		]);

		expect(result.exitCode).toBe(0);
		expect(result.error?.stopReason).toBe(UNFINISHED);
		expect(result.error?.message).toContain("web_read");
		expect(result.error?.message).not.toContain("web_search");
		expect(persisted.state).toBe("errored");
	});

	it("is unfinished when it never says its run ended", async () => {
		const { result, persisted } = await supervise([said("half an answer")]);

		expect(result.error?.stopReason).toBe(UNFINISHED);
		expect(persisted.state).toBe("errored");
	});

	it("is complete when it ends its run", async () => {
		const { result, persisted } = await supervise([
			said("the answer"),
			AGENT_END,
			AGENT_SETTLED,
		]);

		expect(result.error).toBeUndefined();
		expect(result.finalAssistantText).toBe("the answer");
		expect(persisted.state).toBe("complete");
	});

	// agent_end carries every message of the run, so on a long one it is
	// the line most likely to be over the cap and skipped. Small enough to
	// arrive whole, or large enough to span pipe chunks: two skip paths.
	// Its kind is all that is read of it, so skipping it is not a loss
	// worth a warning.
	it.each([
		["arrives whole", 4096],
		["spans chunks", 256 * 1024],
	])(
		"is complete when its agent_end was too large to read and %s",
		async (_, size) => {
			const huge = JSON.stringify({
				type: "agent_end",
				messages: [{ role: "assistant", content: "x".repeat(size) }],
			});
			const { result, persisted } = await supervise(
				[said("the answer"), huge],
				{
					maxLineBytes: 1024,
				},
			);

			expect(result.warnings?.join(" ") ?? "").not.toContain(
				"exceeded 1024 bytes",
			);
			expect(result.error).toBeUndefined();
			expect(persisted.state).toBe("complete");
		},
	);

	// The prompt comes back as the user's message, and a council's brief
	// is over the cap: nothing read is lost, so nothing is said of it.
	it("says nothing of a skipped line that only echoed the prompt", async () => {
		const asked = (type: string) =>
			JSON.stringify({
				type,
				message: {
					role: "user",
					content: [{ type: "text", text: "x".repeat(4096) }],
				},
			});
		const { result, persisted } = await supervise(
			[
				asked("message_start"),
				asked("message_end"),
				said("the answer"),
				AGENT_END,
				AGENT_SETTLED,
			],
			{ maxLineBytes: 1024 },
		);

		expect(result.warnings?.join(" ") ?? "").not.toContain("exceeded");
		expect(result.finalAssistantText).toBe("the answer");
		expect(persisted.state).toBe("complete");
	});

	// A tool result can be over the cap too, and a skipped end is not a
	// tool still running once the run itself has said it finished.
	it("is complete when the run ended even though a tool end was unread", async () => {
		const { result, persisted } = await supervise([
			started("a", "read"),
			said("the answer"),
			AGENT_END,
			AGENT_SETTLED,
		]);

		expect(result.error).toBeUndefined();
		expect(persisted.state).toBe("complete");
	});
});

/**
 * The child runs in its own process group, so the supervisor is the only
 * thing that can stop it. A signal that kills the supervisor instead of
 * reaching its handler leaves a pi running that nobody will ever stop.
 */
describe("a supervisor that is signalled", () => {
	function alive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			// ESRCH: nothing has that pid any more.
			return false;
		}
	}

	/**
	 * Start a run whose child holds on, send the supervisor these signals
	 * once the child is up, and say whether the child outlived the run.
	 */
	async function signalled(
		signals: readonly NodeJS.Signals[],
		options: { deaf: boolean },
	): Promise<{ result: RunPiResult; outlived: boolean; state: string }> {
		const stateDir = await tempStateDir();
		const marker = join(stateDir, "child-pid");
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			[
				'import { writeFileSync } from "node:fs";',
				...(options.deaf ? ['process.on("SIGTERM", () => {});'] : []),
				`writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		let supervisor: ChildProcess | undefined;
		const runPi = runChild(childPath, stateDir, {
			killGraceMs: 500,
			spawn: (command, args, spawnOptions) => {
				supervisor = nodeSpawn(command, args, spawnOptions);
				return supervisor;
			},
		});
		const running = runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "signalled",
		});
		let childPid = 0;
		while (childPid === 0) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			childPid = Number(await readFile(marker, "utf-8").catch(() => "0"));
		}
		for (const signal of signals) {
			supervisor?.kill(signal);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const result = await running;
		const outlived = alive(childPid);
		// Never leave one behind for the next test to trip over.
		if (outlived) process.kill(-childPid, "SIGKILL");
		const resultPath = new ReviewerArtifactsStore(stateDir).paths(
			"run",
			"signalled",
		).resultPath;
		const persisted = await readFile(resultPath, "utf-8")
			.then((text) => JSON.parse(text).state as string)
			.catch(() => "none");
		return { result, outlived, state: persisted };
	}

	it("stops its child when the terminal hangs up", async () => {
		const { outlived, state } = await signalled(["SIGHUP"], { deaf: false });

		expect(outlived, "the child is gone once the run ends").toBe(false);
		expect(state).toBe("cancelled");
	});

	it("still kills a child that ignored the first stop when asked again", async () => {
		// The second signal lands inside the kill grace, while the child
		// is ignoring the first. Taking it by default would end the one
		// process holding the SIGKILL that grace is waiting to send.
		const { outlived, state } = await signalled(["SIGTERM", "SIGTERM"], {
			deaf: true,
		});

		expect(outlived, "the child is gone once the run ends").toBe(false);
		expect(state).toBe("cancelled");
	});

	it("never starts a child for a run already cancelled", async () => {
		// A run's later reviewers are prepared while its earlier ones run,
		// so a cancellation can be waiting before this one spawns.
		const stateDir = await tempStateDir();
		const marker = join(stateDir, "child-ran");
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "yes");\nsetInterval(() => {}, 1000);`,
		);
		const store = new ReviewerArtifactsStore(stateDir);
		await store.requestRunCancellation("run", "user");
		const runPi = runChild(childPath, stateDir, {
			killGraceMs: 500,
		});

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "late",
		});

		const persisted = JSON.parse(
			await readFile(store.paths("run", "late").resultPath, "utf-8"),
		);
		expect(persisted.state).toBe("cancelled");
		expect(result.exitCode).toBe(130);
		expect(await readFile(marker, "utf-8").catch(() => "never ran")).toBe(
			"never ran",
		);
	});

	it("carries on when the parent it was reporting to has gone", async () => {
		// A waiting parent reads the supervisor's stdout. When that parent
		// dies, the next activity line meets a closed pipe, and an EPIPE
		// nobody listens for is thrown: the supervisor dies mid-run and
		// the child, in its own group, runs on with nobody to stop it.
		const stateDir = await tempStateDir();
		const marker = join(stateDir, "child-pid");
		const go = join(stateDir, "go");
		const childPath = join(stateDir, "child.mjs");
		const line = (event: object) =>
			`process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)});`;
		await writeFile(
			childPath,
			[
				'import { existsSync, writeFileSync } from "node:fs";',
				`writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
				`while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 20));`,
				line({
					type: "tool_execution_start",
					toolCallId: "a",
					toolName: "web_read",
				}),
				line({
					type: "tool_execution_end",
					toolCallId: "a",
					toolName: "web_read",
				}),
				line({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "read it" }],
					},
				}),
				line({ type: "agent_end", messages: [] }),
			].join("\n"),
		);
		let supervisor: ChildProcess | undefined;
		const store = new ReviewerArtifactsStore(stateDir);
		const runPi = runChild(childPath, stateDir, {
			spawn: (command, args, spawnOptions) => {
				supervisor = nodeSpawn(command, args, spawnOptions);
				return supervisor;
			},
		});
		const running = runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "orphaned-output",
		});
		while ((await readFile(marker, "utf-8").catch(() => "")) === "") {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		supervisor?.stdout?.destroy();
		await writeFile(go, "");
		const result = await running;

		const persisted = await readFile(
			store.paths("run", "orphaned-output").resultPath,
			"utf-8",
		)
			.then((text) => JSON.parse(text))
			.catch(() => ({ state: "none" }));
		expect(persisted.state, result.stderrTail).toBe("complete");
		expect(persisted.finalAssistantText).toBe("read it");
	});

	it("still kills it when interrupted twice", async () => {
		const { outlived, state } = await signalled(["SIGINT", "SIGINT"], {
			deaf: true,
		});

		expect(outlived, "the child is gone once the run ends").toBe(false);
		expect(state).toBe("cancelled");
	});
});

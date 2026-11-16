/**
 * What a reviewer wrote down, read back by the supervisor: its verified
 * output, what it recorded before a stop, its rotated event logs, and
 * never what an earlier attempt under the same ids left behind.
 */

import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSupervisorRunPi as createRealSupervisorRunPi } from "../../../../lib/subagent/runpi/supervisor.ts";
import { at } from "../../../support/at.ts";
import {
	createSupervisorRunPi,
	expectRan,
	GENEROUS_MS,
	runChild,
	TEST_TIMEOUT_MS,
	tempStateDir,
} from "./supervised.ts";

// Slack for spawning, not a work budget: TEST_TIMEOUT_MS says why.
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

describe("createSupervisorRunPi: what a reviewer wrote down", () => {
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
		const runPi = runChild(childPath, stateDir);

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
		expect(result.verification).toMatchObject({ canonicalText: true });
		expect(result.finalAssistantText).toContain("Verified");
		expect(result.finalAssistantText).not.toBe("not json");
	});

	it("reads back what a reviewer wrote down before it was stopped", async () => {
		// The point of the journal: a child that records two findings
		// and is then killed mid-sentence has still produced two
		// findings. Everything else in this file recovers an answer,
		// and an answer only exists if the reviewer reached the end.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "journal-child.mjs");
		await writeFile(
			childPath,
			[
				`import { appendFileSync } from "node:fs";`,
				"const path = process.env.SUBAGENT_JOURNAL_PATH;",
				`appendFileSync(path, JSON.stringify({ subject: "the first" }) + "\\n");`,
				`appendFileSync(path, JSON.stringify({ subject: "the second" }) + "\\n");`,
				// Killed partway through the third, which is what a wall
				// clock does to a reviewer mid-write.
				`appendFileSync(path, '{"subject": "the th');`,
				`process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } }) + "\\n");`,
			].join("\n"),
		);
		const runPi = runChild(childPath, stateDir);

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "journalled",
		});

		// The half-written line costs itself and nothing above it.
		expect(result.journal).toEqual([
			{ subject: "the first" },
			{ subject: "the second" },
		]);
		// Said in a channel of its own as well, because a round
		// replaces a participant's warnings with a sentence about the
		// stop, and this one says a finding was left behind.
		expect(result.journalWarnings?.join(" ")).toMatch(/1 could not be read/);
	});

	it("does not credit a run with what an earlier attempt recorded", async () => {
		// The journal is appended to, so a leftover file would be read
		// as this run's work and attributed to a reviewer that never
		// found it.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "second-attempt-child.mjs");
		await writeFile(
			childPath,
			[
				`import { appendFileSync } from "node:fs";`,
				`appendFileSync(process.env.SUBAGENT_JOURNAL_PATH, JSON.stringify({ subject: "this attempt" }) + "\\n");`,
				`process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } }) + "\\n");`,
			].join("\n"),
		);
		const runPi = runChild(childPath, stateDir);
		const once = { args: [], cwd: stateDir, runId: "run", reviewerId: "twice" };

		await runPi(once);
		const again = await runPi(once);

		expect(again.journal).toEqual([{ subject: "this attempt" }]);
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
		const runPi = runChild(childPath, stateDir, {
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
		expect(at(output.findings, 0).discussion).toBe(bigDiscussion);
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
		const runPi = runChild(childPath, stateDir);

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "unkeyed",
		});

		expect(result.verification).not.toHaveProperty("output");
		expect(result.verification).toMatchObject({ canonicalText: true });
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
});

describe("a reviewer run again under the same ids", () => {
	// A retry lands in the directory of the attempt before it. When the
	// new supervisor dies before it writes anything, whatever is in
	// result.json is the last attempt's, and reading it back reports an
	// answer this attempt never gave.
	it("does not answer with the attempt before it", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			[
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"the first answer"}]}})+"\\n");`,
				`process.stdout.write(JSON.stringify({type:"agent_end",messages:[]})+"\\n");`,
			].join("\n"),
		);
		const crashing = join(stateDir, "crashing-supervisor.mjs");
		await writeFile(crashing, "process.exit(1);\n");
		const ids = { args: [], cwd: stateDir, runId: "run", reviewerId: "again" };
		const config = {
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		};
		const first = await createSupervisorRunPi(config)(ids);
		expect(first.finalAssistantText).toBe("the first answer");

		const second = await createRealSupervisorRunPi({
			...config,
			supervisorPath: crashing,
		})(ids);

		expect(second.finalAssistantText).toBe("");
		expect(second.exitCode).not.toBe(0);
		expect(second.warnings?.join(" ")).toContain("without a terminal result");
	});
});

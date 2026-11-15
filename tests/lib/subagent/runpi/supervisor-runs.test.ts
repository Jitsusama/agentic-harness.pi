/**
 * A supervised run and what it reports: its answer, the reserve that
 * stops it early, the state that ended it, the session it kept and
 * what it read off the child's stream.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "./fake-child.ts";
import { TEST_TIMEOUT_MS, tempStateDir, runChild, runOnFake, fakeSupervisor, expectRan } from "./supervised.ts";

// Slack for spawning, not a work budget: TEST_TIMEOUT_MS says why.
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

describe("createSupervisorRunPi: a run and what it reports", () => {
	it("runs the real supervisor script against a JSON-emitting child", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			[
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"supervised"}],usage:{input:1,output:2,totalTokens:3,cost:{total:0.01}}}})+"\\n");`,
				// How pi says the run is over, without which it is not.
				`process.stdout.write(JSON.stringify({type:"agent_end",messages:[]})+"\\n");`,
			].join("\n"),
		);
		const runPi = runChild(childPath, stateDir);

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
		expect(result.state).toBe("complete");
	});

	it("stops a healthy child early when an answer has been reserved for", async () => {
		// Driven through the real script and a real child, unlike the
		// state test below, because the claim here is about a timer
		// firing on a deadline nobody has ever run. A soft deadline that
		// silently never fires looks exactly like a reviewer that
		// finished in time, and the only thing that can tell them apart
		// is a child that would otherwise run forever.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			// Says something, so it is plainly alive rather than idle, then
			// never finishes.
			`process.stdout.write(JSON.stringify({type:"message_start"})+"\\n");` +
				`setInterval(() => process.stdout.write(JSON.stringify({type:"message_start"})+"\\n"), 200);`,
		);
		const runPi = runChild(childPath, stateDir);

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "reserved",
			// Sixteen seconds of wall clock, twelve of which are the
			// reviewer's and four kept back for its answer. Wider than the
			// arithmetic needs on purpose: this file's own header records
			// CI taking tens of seconds just to get a doubly-nested node
			// spawn moving, and a four-second window between the deadline
			// that should fire and the one that should not would decide
			// this test on scheduler luck.
			timeoutMs: 16_000,
			wrapUpReserveMs: 4_000,
		});

		expect(result.state).toBe("soft-deadline");
		// The derived number, not just the state: a supervisor that
		// stopped at the reserve itself rather than at the wall minus
		// the reserve would report the same state and the wrong moment.
		expect(result.warnings?.join(" ")).toMatch(/soft deadline of 12000ms/);
	}, 90_000);

	it("refuses a reserve that would leave no time to review in", async () => {
		// The refusal nothing reached: a reserve at least half the wall
		// clock means somebody has misconfigured this, and the safe
		// reading is that the run wants its whole budget rather than
		// being asked to wrap up before it has read anything. Checked on
		// the request the supervisor is handed, since the absence of a
		// deadline is not visible in any outcome.
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		let asked: { softDeadlineMs?: number; timeoutMs?: number } = {};
		const runPi = runOnFake(stateDir, {
			spawn: fakeSupervisor(stateDir, fake, (request) => {
				asked = request;
				return { state: "complete", exitCode: 0, finalAssistantText: "done" };
			}),
		});

		await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "greedy",
			timeoutMs: 60_000,
			wrapUpReserveMs: 40_000,
		});

		expect(asked.timeoutMs).toBe(60_000);
		expect(asked.softDeadlineMs).toBeUndefined();
	});

	it("says which state ended a run that was stopped, not just that it failed", async () => {
		// A caller has to tell a reviewer we stopped from one that
		// answered badly, and an exit code cannot carry that: a review
		// council reported seven reviewers as having answered with
		// unparseable output when all seven had been killed at a wall
		// clock. The supervisor has always written the state to its
		// result file; it simply never handed it back.
		//
		// Driven through a fake supervisor rather than a real stuck
		// child, because the claim is that the parent reads the field
		// back off the result file. Proving that with a subprocess that
		// has to be killed would add a spawning test to a suite that
		// already starves them under load, and would not prove any more.
		const stateDir = await tempStateDir();
		const fake = makeFakeChild();
		const runPi = runOnFake(stateDir, {
			spawn: fakeSupervisor(stateDir, fake, () => ({
				state: "timeout",
				exitCode: 124,
				// The conversational line a reviewer says between tool calls,
				// which is what used to be mistaken for its answer.
				finalAssistantText: "Let me check the tests.",
				warnings: ["Pi subprocess timed out after 900000ms; sent SIGTERM."],
			})),
		});

		const result = await runPi({
			args: [],
			cwd: "/tmp/wt",
			runId: "run",
			reviewerId: "slow",
		});

		expect(result.state).toBe("timeout");
		// The thing it said on the way past the wall is still there, so
		// the state is what tells the two apart rather than the text.
		expect(result.finalAssistantText).toBe("Let me check the tests.");
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
				"if (i === -1) { process.exit(3); }",
				"const dir = process.argv[i + 1];",
				"mkdirSync(dir, { recursive: true });",
				`writeFileSync(dir + "/2026-01-01T00-00-00-000Z_abc.jsonl", "{}\\n");`,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}})+"\\n");`,
			].join("\n"),
		);
		const runPi = runChild(childPath, stateDir);

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
		expect((await stat(sessionPath)).isFile(), `${sessionPath} is a file`).toBe(
			true,
		);
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
		const runPi = runChild(childPath, stateDir);

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
		const runPi = runChild(childPath, stateDir);

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
		const runPi = runChild(childPath, stateDir);

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
	it("reports the session the child announced, which is the id its bill carries", async () => {
		// pi announces its session before its first request, even with
		// --no-session, and the AI proxy bills every request under that id.
		// Recorded, a job joins its bill exactly instead of by summing
		// tokens, which missed about $850 of fan-out in a month.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "session-child.mjs");
		await writeFile(
			childPath,
			[
				`process.stdout.write(JSON.stringify({type:"session",version:3,id:"01a0cff2-4244-75ad-b91b-7bdc1bc970b7",cwd:"/"})+"\\n");`,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}})+"\\n");`,
			].join("\n"),
		);
		const runPi = runChild(childPath, stateDir);

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "announced",
		});

		expectRan(result);
		expect(result.sessionIds).toEqual(["01a0cff2-4244-75ad-b91b-7bdc1bc970b7"]);
	});

	it("reports no session for a child that never announced one", async () => {
		// Watched from its first byte to its last, so this is known rather
		// than missing: a child that never announced never made a request.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "silent-child.mjs");
		await writeFile(
			childPath,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}})+"\\n");`,
		);
		const runPi = runChild(childPath, stateDir);

		const result = await runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "silent",
		});

		expectRan(result);
		expect(result.sessionIds).toEqual([]);
	});
});

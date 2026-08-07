/**
 * A round started and abandoned on purpose, then finished later.
 *
 * The two halves are tested apart: `startCouncil` knows nothing about
 * supervisors, and `startReviewer` knows nothing about rounds. What
 * neither of them can show is the thing being sold, which is that a
 * round dispatched by one session can be turned back into findings by
 * another. That is a property of the pair plus the disk between them,
 * so it is asserted here against the real artifact store, the real
 * path builder and the real collect path.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	answerLeftBehind,
	heldByLiveSupervisor,
	reviewerStarter,
} from "../../extensions/review-integration/reviewer.js";
import type {
	AskAnswer,
	AskRun,
	ChangeRef,
	Finding,
} from "../../lib/review/index.js";
import {
	collectRound,
	createRunStore,
	startCouncil,
} from "../../lib/review/index.js";
import {
	ReviewerArtifactsStore,
	startReviewer,
} from "../../lib/subagent/index.js";

/** The parts of a run everyoneFinished reads, for a single reviewer. */
const RUN: AskRun = {
	id: "run",
	round: "council",
	startedAt: "2026-08-06T00:00:00.000Z",
	participants: [{ id: "hawk", role: "reviewer" }],
	outcomes: [],
};

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pr-detached-round-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A child that answers with one finding and takes its time doing it. */
const CHILD = `await new Promise((r) => setTimeout(r, 200));
const answer = JSON.stringify({ findings: [{
  location: { kind: "file", file: "lib/a.ts" },
  label: "issue",
  subject: "started and left alone",
  discussion: "nobody was waiting"
}]});
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:answer}]}})+"\\n");`;

/**
 * A child slow enough that its supervisor is still holding the lease
 * when the round comes back, which is the state the guard exists for.
 */
const SLOW_CHILD = `await new Promise((r) => setTimeout(r, 2500));
const answer = JSON.stringify({ findings: [{
  location: { kind: "file", file: "lib/a.ts" },
  label: "issue",
  subject: "started and left alone",
  discussion: "nobody was waiting"
}]});
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:answer}]}})+"\\n");`;

/** Poll until something is true, saying what never happened if it is not. */
async function waitFor(
	ready: () => Promise<boolean>,
	complaint: string,
): Promise<void> {
	const until = Date.now() + 30_000;
	while (Date.now() < until) {
		if (await ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(complaint);
}

/** Wait for every reviewer in a round to have written its result. */
async function everyoneFinished(run: AskRun): Promise<void> {
	const store = new ReviewerArtifactsStore(root);
	const until = Date.now() + 60_000;
	while (Date.now() < until) {
		const left = await Promise.all(
			run.participants.map((p) => answerLeftBehind(store, run.id, p.id)),
		);
		if (left.every((one) => one.kind === "answer")) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("the reviewers never finished");
}

describe("a round nobody waited for", () => {
	it("is dispatched, abandoned, and collected into findings", async () => {
		const childPath = join(root, "child.mjs");
		writeFileSync(childPath, CHILD);
		const starter = reviewerStarter(
			{ node: process.execPath, entry: childPath },
			root,
		);
		const opened: AskRun[] = [];

		// The session that starts it. Everything it knows ends here.
		const { run } = await startCouncil(
			{
				roster: { reviewers: [{ id: "hawk" }, { id: "owl" }] },
				prompt: "read it",
				seq: 1,
				witness: "abc1234",
			},
			{
				now: () => new Date(),
				async opened(entry) {
					opened.push(entry);
				},
				async start(participant, prompt, runId) {
					await startReviewer({
						reviewer: { id: participant.id },
						prompt,
						cwd: root,
						runId,
						stateDir: root,
						startPi: starter,
						timeoutMs: 30_000,
						idleTimeoutMs: 30_000,
					});
				},
			},
		);

		expect(opened[0]?.open).toBe(true);
		expect(run.open).toBe(true);

		await everyoneFinished(run);

		// A different session entirely: all it has is the ledger entry
		// and the state directory.
		const store = new ReviewerArtifactsStore(root);
		const answers = new Map<string, AskAnswer>();
		for (const participant of run.participants) {
			const left = await answerLeftBehind(store, run.id, participant.id);
			if (left.kind === "answer") answers.set(participant.id, left.answer);
		}
		const kept: Finding[] = [];
		const { run: settled } = await collectRound(run, answers, {
			async record(findings) {
				const numbered = findings.map((finding, index) => ({
					...finding,
					id: kept.length + index + 1,
				}));
				kept.push(...numbered);
				return numbered;
			},
		});

		expect(settled.open).toBeUndefined();
		expect(kept).toHaveLength(2);
		expect(kept[0]?.subject).toBe("started and left alone");
		// Anchored against the witness the starting session recorded,
		// which is the one thing a collect cannot work out for itself.
		expect(kept[0]?.origin).toMatchObject({ runId: run.id });
	}, 90_000);

	it("is refused while its supervisors are alive, then read back off the ledger", async () => {
		// The half the other case fakes. It hands the run object across
		// the session boundary, which is the one thing a second session
		// cannot do: all it has is the ledger and the state directory.
		// And nothing exercised the guard that stops a collect landing
		// while somebody is still writing, which is what keeps one
		// round's findings from being filed twice.
		const childPath = join(root, "child.mjs");
		writeFileSync(childPath, SLOW_CHILD);
		const starter = reviewerStarter(
			{ node: process.execPath, entry: childPath },
			root,
		);
		const ledger = createRunStore(join(root, "ledger"));
		const change: ChangeRef = {
			provider: "github",
			repo: { key: "github:Jitsusama/agentic-harness.pi" },
			id: "1",
			label: "Jitsusama/agentic-harness.pi#1",
		};

		const { run } = await startCouncil(
			{
				roster: { reviewers: [{ id: "hawk" }] },
				prompt: "read it",
				seq: 1,
				witness: "abc1234",
			},
			{
				now: () => new Date(),
				// The real one. A fake here is what let the round be
				// written in a shape nothing reads back.
				opened: (entry) => ledger.keep(change, entry),
				async start(participant, prompt, runId) {
					await startReviewer({
						reviewer: { id: participant.id },
						prompt,
						cwd: root,
						runId,
						stateDir: root,
						startPi: starter,
						timeoutMs: 30_000,
						idleTimeoutMs: 30_000,
					});
				},
			},
		);

		const store = new ReviewerArtifactsStore(root);
		const ids = run.participants.map((one) => one.id);
		// Real facts, real pid, real lease file. Collecting now would
		// file the findings of whoever has finished and then let the
		// session still running file them again.
		await waitFor(
			async () =>
				(await heldByLiveSupervisor(store, run.id, ids)) !== undefined,
			"no supervisor ever took the lease",
		);

		await everyoneFinished(run);
		await waitFor(
			async () =>
				(await heldByLiveSupervisor(store, run.id, ids)) === undefined,
			"the lease was never given back",
		);

		// A second session: a new store over the same directory, and
		// the round fetched by its id rather than carried in memory.
		const later = createRunStore(join(root, "ledger"));
		const held = await later.byId(change, run.id);
		expect(held?.open).toBe(true);
		expect(held?.witness).toBe("abc1234");

		const answers = new Map<string, AskAnswer>();
		for (const participant of held?.participants ?? []) {
			const left = await answerLeftBehind(store, run.id, participant.id);
			if (left.kind === "answer") answers.set(participant.id, left.answer);
		}
		const kept: Finding[] = [];
		const { run: settled } = await collectRound(held as AskRun, answers, {
			async record(findings) {
				const numbered = findings.map((finding, index) => ({
					...finding,
					id: kept.length + index + 1,
				}));
				kept.push(...numbered);
				return numbered;
			},
		});
		await ledger.keep(change, settled);

		expect(kept).toHaveLength(1);
		expect(kept[0]?.subject).toBe("started and left alone");
		// And the ledger holds the settled round rather than a second
		// copy beside the open one.
		const after = await later.list(change);
		expect(after).toHaveLength(1);
		expect(after[0]?.open).toBeUndefined();
	}, 90_000);

	it("keeps the question, so an abandoned round can still be read", async () => {
		const childPath = join(root, "child.mjs");
		writeFileSync(childPath, CHILD);

		const started = await startReviewer({
			reviewer: { id: "hawk" },
			prompt: "the question nobody else recorded",
			cwd: root,
			runId: "run",
			stateDir: root,
			startPi: reviewerStarter(
				{ node: process.execPath, entry: childPath },
				root,
			),
			timeoutMs: 30_000,
			idleTimeoutMs: 30_000,
		});

		const { promptPath } = new ReviewerArtifactsStore(root).paths(
			"run",
			"hawk",
		);
		expect(readFileSync(promptPath, "utf8")).toBe(
			"the question nobody else recorded",
		);

		// Waited for on the way out, or afterEach deletes the state
		// directory under a supervisor still writing into it. The process
		// outliving the test is the point of the feature and the one
		// thing a suite testing it has to clean up after.
		expect(started.pid).toBeGreaterThan(0);
		await everyoneFinished(RUN);
	}, 60_000);
});

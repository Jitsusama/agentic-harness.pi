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
	whyNotYet,
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
	supervisorStanding,
	systemFacts,
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
/** Rounds this test spawned supervisors for, so teardown can wait. */
let spawned: AskRun[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pr-detached-round-"));
	spawned = [];
});

// Waited out before the directory goes, however the case ended. A
// detached supervisor is deliberately nobody's child: it is spawned
// unref'd and without a parent pid, so nothing in this process owns
// it and a case that throws between the spawn and its last wait would
// otherwise have the state directory deleted out from under a
// supervisor still writing into it. That is a failure in a later
// unrelated case, or a green run over files nobody wrote.
afterEach(async () => {
	const store = new ReviewerArtifactsStore(root);
	const until = Date.now() + 30_000;
	for (const run of spawned) {
		const ids = run.participants.map((one) => one.id);
		while (
			Date.now() < until &&
			(await heldByLiveSupervisor(store, run.id, ids)) !== undefined
		) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	rmSync(root, { recursive: true, force: true });
});

/**
 * A child that answers with one finding, after however long.
 *
 * The pause is the whole variable. A round is collected once every
 * reviewer has written its result, so a child that answers instantly
 * can have released its lease before anything looks, and the guard
 * that refuses a collect mid-flight would then be tested against a
 * round nobody was holding.
 */
function child(pauseMs: number): string {
	return `await new Promise((r) => setTimeout(r, ${pauseMs}));
const answer = JSON.stringify({ findings: [{
  location: { kind: "file", file: "lib/a.ts" },
  label: "issue",
  subject: "started and left alone",
  discussion: "nobody was waiting"
}]});
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:answer}]}})+"\\n");`;
}

/** Poll until something is true, saying what never happened if it is not. */
async function waitFor(
	ready: () => Promise<boolean>,
	complaint: string,
): Promise<void> {
	const until = Date.now() + 20_000;
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
	it("is refused while it runs, then collected by a session that only has the disk", async () => {
		// One case rather than two, because the one it replaces faked
		// both of the things that make this hard and then said in a
		// comment that it had not: it pushed the opening entry into an
		// array, so nothing read back what was written, and it handed
		// the run object straight to the collect, which is the one
		// thing a later session cannot do.
		const childPath = join(root, "child.mjs");
		// Long enough that the round is still being held when the guard
		// is asked, and the wait below is what actually decides it: the
		// number only has to be longer than a spawn.
		writeFileSync(childPath, child(2500));
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

		// The session that starts it. Everything it knows ends here.
		const { run, started, warnings } = await startCouncil(
			{
				// Two, because one reviewer cannot make the situation the
				// guard exists for: findings filed by a session that
				// collected while another was still writing.
				roster: { reviewers: [{ id: "hawk" }, { id: "owl" }] },
				prompt: "read it",
				seq: 1,
				witness: "abc1234",
			},
			{
				now: () => new Date(),
				// The real store. A fake here is what let the round be
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
		spawned.push(run);

		// Said now rather than discovered as a timeout in twenty
		// seconds. A reviewer that would not spawn is the likeliest way
		// for this case to break, and the reason is in hand right here.
		expect(warnings).toEqual([]);
		expect(started).toBe(2);

		// The second session, from here on: a new store over the same
		// directory, and the round fetched by its id.
		const later = createRunStore(join(root, "ledger"));
		const held = await later.byId(change, run.id);
		if (held === undefined) throw new Error("the round was never written");
		expect(held.open).toBe(true);
		expect(held.witness).toBe("abc1234");

		// The refusal itself, not the read under it. Real facts, real
		// pids, real lease files, and the roster as the ledger has it
		// rather than as this process happens to remember it.
		const store = new ReviewerArtifactsStore(root);
		await waitFor(
			async () => (await whyNotYet(store, held)) !== undefined,
			"a collect was never refused: no supervisor took a lease, or every reviewer finished before anything looked",
		);
		expect(await whyNotYet(store, held)).toContain("is still being run");

		await everyoneFinished(held);
		// Given back rather than merely gone. Both read as nothing
		// holding the round, and only one of them is the supervisor
		// closing its lease on the way out, so asking the weaker
		// question would pass against a supervisor that died.
		await waitFor(
			async () =>
				(await supervisorStanding(store, held.id, "hawk", systemFacts)).kind ===
				"finished",
			"the lease was never closed, so nothing distinguishes a finished supervisor from a dead one",
		);
		expect(await whyNotYet(store, held)).toBeUndefined();

		const answers = new Map<string, AskAnswer>();
		for (const participant of held.participants) {
			const left = await answerLeftBehind(store, held.id, participant.id);
			if (left.kind === "answer") answers.set(participant.id, left.answer);
		}
		const kept: Finding[] = [];
		const { run: settled } = await collectRound(held, answers, {
			async record(findings) {
				const numbered = findings.map((finding, index) => ({
					...finding,
					id: kept.length + index + 1,
				}));
				kept.push(...numbered);
				return numbered;
			},
		});
		await later.keep(change, settled);

		expect(settled.open).toBeUndefined();
		expect(kept).toHaveLength(2);
		expect(kept[0]?.subject).toBe("started and left alone");
		expect(kept[0]?.origin).toMatchObject({ runId: run.id });
		// Anchored against the witness the starting session recorded,
		// which is the one thing a collect cannot work out for itself
		// and the reason the witness is on the ledger at all.
		expect(kept[0]?.anchor).toMatchObject({ witness: "abc1234" });
		// And the ledger holds the settled round in place rather than a
		// second copy beside the open one.
		const after = await later.list(change);
		expect(after).toHaveLength(1);
		expect(after[0]?.open).toBeUndefined();
	}, 90_000);

	it("keeps the question, so an abandoned round can still be read", async () => {
		const childPath = join(root, "child.mjs");
		writeFileSync(childPath, child(200));
		spawned.push(RUN);

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

		// The process outliving the test is the point of the feature and
		// the one thing a suite testing it has to clean up after, which
		// teardown now does for every round however the case ended.
		expect(started.pid).toBeGreaterThan(0);
	}, 60_000);
});

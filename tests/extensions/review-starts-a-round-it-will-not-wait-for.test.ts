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
	reviewerStarter,
} from "../../extensions/review-integration/reviewer.js";
import type { AskAnswer, AskRun, Finding } from "../../lib/review/index.js";
import { collectRound, startCouncil } from "../../lib/review/index.js";
import {
	ReviewerArtifactsStore,
	startReviewer,
} from "../../lib/subagent/index.js";

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

	it("keeps the question, so an abandoned round can still be read", async () => {
		const childPath = join(root, "child.mjs");
		writeFileSync(childPath, CHILD);

		await startReviewer({
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
	}, 60_000);
});

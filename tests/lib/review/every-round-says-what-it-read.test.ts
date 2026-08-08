/**
 * Every kind of round records the commit it was formed against.
 *
 * An anchor carries a witness so it stays honest across a force-push:
 * one backend keeps the commit reachable and has no notion of a stale
 * comment, another strands the thread and reports it as outdated, and
 * the witness is what lets the substrate say which happened. The run
 * carries the same fact for the round as a whole, and a collect that
 * settles a round later reads it off the run rather than off the
 * findings.
 *
 * Only the council ever recorded it. Measured against the ledger: all
 * sixteen judge rounds are unable to say what they judged, while every
 * council beside them can, and the judge is handed the commit and uses
 * it to anchor its own findings on the way past.
 *
 * A case per round kind rather than one loop, because they are four
 * separate builders with four separate request types, which is exactly
 * why three of them drifted.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AskAnswer, Participant } from "../../../lib/review/index.js";
import {
	runAudit,
	runCouncil,
	runCritique,
	runJudge,
} from "../../../lib/review/index.js";

const WITNESS = "abc1234";
const hawk: Participant = { id: "hawk" };

/** An answer in whatever shape the round asking for it wants. */
function answering(text: string) {
	return {
		async ask(): Promise<AskAnswer> {
			return { text };
		},
		async record(findings: unknown[]): Promise<unknown[]> {
			return findings.map((finding, index) => ({
				...(finding as object),
				id: index + 1,
			}));
		},
		now: () => new Date("2026-08-07T00:00:00.000Z"),
	};
}

/**
 * The wire shape a critique reads.
 *
 * Taken from the reader rather than from another test: the key is
 * `critiques` and each entry names `findingId`, `position` and
 * `rationale`. A fixture in any other shape parses into nothing, and
 * the round then proves the witness on its parse-failure path, which
 * is not the path anybody cares about.
 */
const POSITION = JSON.stringify({
	critiques: [{ findingId: 1, position: "agree", rationale: "it does leak" }],
});

/** The wire shape an audit reads: `audits`, with a `threadIndex`. */
const STANDING = JSON.stringify({
	audits: [
		{ threadIndex: 1, standing: "addressed", rationale: "fixed in place" },
	],
});

/** The wire shape a reviewer or judge answers with. */
const FOUND = JSON.stringify({
	findings: [
		{
			location: { kind: "file", file: "lib/a.ts" },
			label: "issue",
			subject: "something",
			discussion: "about it",
		},
	],
});

describe("a round records the commit it was formed against", () => {
	it("on a council", async () => {
		const { run } = await runCouncil(
			{ roster: { reviewers: [hawk] }, prompt: "p", seq: 1, witness: WITNESS },
			answering(FOUND) as never,
		);

		expect(run.witness).toBe(WITNESS);
	});

	it("on a judge", async () => {
		const { run } = await runJudge(
			{ judge: hawk, prompt: "p", seq: 1, witness: WITNESS },
			answering(FOUND) as never,
		);

		expect(run.witness).toBe(WITNESS);
	});

	it("on a critique", async () => {
		const { run, critiques } = await runCritique(
			{
				roster: { reviewers: [hawk] },
				prompt: "p",
				seq: 1,
				findingIds: [1],
				witness: WITNESS,
			},
			answering(POSITION) as never,
		);

		expect(run.witness).toBe(WITNESS);
		// And on a round that read its answer, not one that fell through
		// the parse-failure path with nothing in it.
		expect(critiques).toHaveLength(1);
	});

	it("on an audit", async () => {
		const { run, audits } = await runAudit(
			{
				auditor: hawk,
				prompt: "p",
				seq: 1,
				threadIndices: [1],
				witness: WITNESS,
			},
			answering(STANDING) as never,
		);

		expect(run.witness).toBe(WITNESS);
		expect(audits).toHaveLength(1);
	});

	it("including a kind these cases have not heard of", async () => {
		// The cases above name four round kinds, and a fifth would be
		// written by somebody who never reads this file. Every builder
		// that stamps a round with its kind has to carry the witness
		// onto the run it returns, so the omission that took three of
		// the four this long to notice cannot be made quietly again.
		const dir = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"..",
			"lib",
			"review",
			"ask",
		);
		const builders: string[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".ts")) continue;
			const source = readFileSync(join(dir, name), "utf8");
			// Every builder stamps a run with the moment it started, and
			// that is what identifies one. Looking for the round's kind as
			// a literal missed the council, which takes it from the
			// opening and writes it shorthand: the scan could not see the
			// one builder that was already right, and the count it was
			// checked against happened to match without it.
			const built =
				source.split("startedAt: startedAt.toISOString()").length - 1;
			if (built === 0) continue;
			builders.push(name);
			// One spelling now, because what a round read is one fact
			// and was being written by hand in four different ways.
			// Recording the commit without the caveat is the failure
			// that matters: the run then says the reviewers read the
			// change when they read whatever was checked out.
			//
			// The stack round is the one honest exception, and it is
			// checked rather than skipped: it holds every change in a
			// stack at once, so a single commit on the run would name
			// the wrong change for all but one of them. It carries a
			// witness per change instead, which is the same promise in
			// the only shape that can be true there.
			//
			// Counted, not merely found. Asking whether the file mentions
			// the helper anywhere let council.ts pass on one builder while
			// the other, the one a detached round and an interrupted one
			// both go through, still wrote the commit by hand. That is
			// precisely the fault this gate exists to prevent, and this
			// gate had it.
			//
			// At least one per builder rather than exactly one, because a
			// file may honestly call it once and spread the result twice,
			// which council.ts does. So this does not prove each builder
			// is the one carrying it; it proves no file grew a builder
			// without growing a reader, which is how the last one hid.
			//
			// The stack round's exemption covers the witness and stops
			// there. A stack is read in one tree like everything else, so
			// a fallback is a fact about the whole round, and the
			// exemption was quietly excusing it from saying so.
			if (name === "stack-round.ts") {
				expect({
					name,
					witnesses: source.includes("request.witnessFor,"),
					caveat: source.includes("whatItRead({"),
				}).toEqual({ name, witnesses: true, caveat: true });
				continue;
			}
			const spelling = "whatItRead(request)";
			const carries = source.split(spelling).length - 1;
			expect({ name, enough: carries >= built }).toEqual({
				name,
				enough: true,
			});
		}

		// The canary, naming them rather than counting them, because a
		// count is what let a missing builder look like a full sweep.
		// `collect.ts` is not among them and should not be: it settles a
		// round somebody else formed, spreading what that round already
		// held, so it inherits the witness rather than choosing one.
		expect(builders.sort()).toEqual([
			"audit.ts",
			"council.ts",
			"critique.ts",
			"judge.ts",
			"stack-round.ts",
		]);
	});

	it("and says nothing when it was given nothing", async () => {
		// The absence is a fact too: a provider that does not report a
		// head commit is ordinary, and an empty string or a placeholder
		// would be a worse answer than silence.
		const { run } = await runJudge(
			{ judge: hawk, prompt: "p", seq: 1 },
			answering(FOUND) as never,
		);

		expect(run.witness).toBeUndefined();
	});
});

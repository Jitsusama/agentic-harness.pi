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
		const { run } = await runCritique(
			{
				roster: { reviewers: [hawk] },
				prompt: "p",
				seq: 1,
				findingIds: [1],
				witness: WITNESS,
			},
			answering(
				JSON.stringify({
					positions: [{ finding: 1, position: "agree", reasoning: "yes" }],
				}),
			) as never,
		);

		expect(run.witness).toBe(WITNESS);
	});

	it("on an audit", async () => {
		const { run } = await runAudit(
			{
				auditor: hawk,
				prompt: "p",
				seq: 1,
				threadIndices: [1],
				witness: WITNESS,
			},
			answering(
				JSON.stringify({
					standings: [
						{ thread: 1, standing: "addressed", reasoning: "it was" },
					],
				}),
			) as never,
		);

		expect(run.witness).toBe(WITNESS);
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
			if (!/^\t+round: "[a-z]+",$/m.test(source)) continue;
			builders.push(name);
			// The stack round is the one honest exception, and it is
			// checked rather than skipped: it holds every change in a
			// stack at once, so a single commit on the run would name
			// the wrong change for all but one of them. It carries a
			// witness per change instead, which is the same promise in
			// the only shape that can be true there.
			const carries = source.includes(
				name === "stack-round.ts" ? "witnessFor" : "witness: request.witness",
			);
			expect({ name, carries }).toEqual({ name, carries: true });
		}

		// The canary: a scan that matched nothing would pass forever.
		expect(builders.length).toBeGreaterThanOrEqual(4);
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

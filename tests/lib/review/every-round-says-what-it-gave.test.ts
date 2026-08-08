/**
 * Every kind of round records what it handed its reviewers.
 *
 * A reviewer's answer depends on what it was given, and until now the
 * run recorded only who was asked and what they read. Two rounds a
 * week apart, one of them run before reviewers were isolated and one
 * after, leave records that cannot be told apart, and the second is
 * worth more than the first.
 *
 * It is not a hypothetical distinction. The reviewers on the first
 * council against the isolation change reported, correctly, that they
 * were not isolated, and nothing on those runs says so; the only
 * reason anybody knows is that they happened to mention it in prose.
 * That is the charge this change laid against the old behaviour, so
 * leaving the new behaviour equally unrecorded would be the same
 * mistake with a better outcome.
 *
 * A case per round kind rather than one loop, because they are
 * separate builders with separate request types, which is why three
 * of them drifted the last time a fact had to reach all of them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	Participant,
	RoundGiven,
} from "../../../lib/review/index.js";
import {
	runAudit,
	runCouncil,
	runCritique,
	runJudge,
} from "../../../lib/review/index.js";

const hawk: Participant = { id: "hawk" };

/** What a round of the shipped configuration hands a reviewer. */
const GIVEN: RoundGiven = {
	isolated: true,
	quoted: { path: "AGENTS.md", edited: "no" },
};

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

/** The wire shape a critique reads. */
const POSITION = JSON.stringify({
	critiques: [{ findingId: 1, position: "agree", rationale: "it does leak" }],
});

/** The wire shape an audit reads. */
const STANDING = JSON.stringify({
	audits: [
		{ threadIndex: 1, standing: "addressed", rationale: "fixed in place" },
	],
});

describe("a round records what its reviewers were given", () => {
	it("on a council", async () => {
		const { run } = await runCouncil(
			{ roster: { reviewers: [hawk] }, prompt: "p", seq: 1, given: GIVEN },
			answering(FOUND) as never,
		);

		expect(run.given).toEqual(GIVEN);
	});

	it("on a judge", async () => {
		const { run } = await runJudge(
			{ judge: hawk, prompt: "p", seq: 1, given: GIVEN },
			answering(FOUND) as never,
		);

		expect(run.given).toEqual(GIVEN);
	});

	it("on a critique", async () => {
		const { run, critiques } = await runCritique(
			{
				roster: { reviewers: [hawk] },
				prompt: "p",
				seq: 1,
				findingIds: [1],
				given: GIVEN,
			},
			answering(POSITION) as never,
		);

		expect(run.given).toEqual(GIVEN);
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
				given: GIVEN,
			},
			answering(STANDING) as never,
		);

		expect(run.given).toEqual(GIVEN);
		expect(audits).toHaveLength(1);
	});

	it("says nothing at all when it was told nothing", async () => {
		// Absent has to stay absent. Every round on disk predates this
		// field, and a builder that helpfully filled in a default would
		// make the entire history claim a configuration nobody can
		// check, which is the thing being fixed rather than a tidier
		// version of it.
		const { run } = await runCouncil(
			{ roster: { reviewers: [hawk] }, prompt: "p", seq: 1 },
			answering(FOUND) as never,
		);

		expect(run.given).toBeUndefined();
		expect("given" in run).toBe(false);
	});

	it("including a kind these cases have not heard of", async () => {
		// The same sweep the witness gets, and for the same reason: the
		// next round kind will be written by somebody who never reads
		// this file, and a fact that reaches four builders out of five
		// is a fact whose absence means nothing.
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
			const built =
				source.split("startedAt: startedAt.toISOString()").length - 1;
			if (built === 0) continue;
			builders.push(name);
			// At least one per builder rather than exactly one, for the
			// same reason the witness sweep counts that way: a file may
			// honestly call it once and spread the result twice. This
			// does not prove each builder carries it, only that no file
			// grew a builder without growing a reader.
			const carries = source.split("whatItGave(request)").length - 1;
			expect({ name, enough: carries >= built }).toEqual({
				name,
				enough: true,
			});
		}

		// Named rather than counted, because a count is what let a
		// missing builder look like a full sweep. The stack round is not
		// exempt here: what its reviewers were given is one fact about
		// the whole round however many changes it reads.
		expect(builders.sort()).toEqual([
			"audit.ts",
			"council.ts",
			"critique.ts",
			"judge.ts",
			"stack-round.ts",
		]);
	});
});

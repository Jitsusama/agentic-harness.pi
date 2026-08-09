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

import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	AskRun,
	Participant,
	RoundGiven,
} from "../../../lib/review/index.js";
import {
	runAudit,
	runCouncil,
	runCritique,
	runJudge,
	runStackCouncil,
	startCouncil,
	substituteOutcome,
} from "../../../lib/review/index.js";
import { BUILDERS, roundBuilders } from "./support/round-builders.js";

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

	it("on a stack round, which reads several changes in one tree", async () => {
		// Named in the canary below and asserted nowhere, which is how a
		// substring count comes to stand in for a behaviour. What its
		// reviewers were given is a single fact however many changes they
		// read, so this round gets no exemption of the kind the witness
		// has to give it.
		const { run } = await runStackCouncil(
			{
				roster: { reviewers: [hawk] },
				prompt: "p",
				seq: 1,
				stackRefs: ["refs/heads/tip"],
				given: GIVEN,
			},
			{
				async ask(): Promise<AskAnswer> {
					return { text: JSON.stringify({ findings: [] }) };
				},
				async record(): Promise<never[]> {
					return [];
				},
				now: () => new Date("2026-08-07T00:00:00.000Z"),
			} as never,
		);

		expect(run.given).toEqual(GIVEN);
	});

	it("on the record a detached round writes before it starts", async () => {
		// The opening record, which is the only thing that will ever say
		// these reviewers were a round, and the one the sweep cannot see:
		// council.ts holds two builders and the sweep counts one, so the
		// spare call satisfied it while this record went out empty.
		let opening: { given?: RoundGiven } | undefined;
		await startCouncil(
			{ roster: { reviewers: [hawk] }, prompt: "p", seq: 1, given: GIVEN },
			{
				now: () => new Date("2026-08-07T00:00:00.000Z"),
				async opened(run) {
					opening = run;
				},
				async start() {},
			},
		);

		expect(opening?.given).toEqual(GIVEN);
	});

	it("on a retried outcome, where the round's may not describe it", async () => {
		// A retry substitutes into a round that may have been recorded
		// before any of this existed, so the round's claim covers the
		// outcomes it originally collected and not this one. Writing
		// today's conditions onto the round would claim them for
		// reviewers who never ran under them, and saying nothing would
		// lose the one fact the retry does know, so the outcome carries
		// them.
		const held: AskRun = {
			id: "council-20260801T000000000-000001",
			round: "council",
			startedAt: "2026-08-01T00:00:00.000Z",
			participants: [{ id: "hawk", role: "reviewer" }],
			outcomes: [{ participantId: "hawk", findingIds: [], failure: "died" }],
		};

		const updated = substituteOutcome(
			held,
			{ participantId: "hawk", findingIds: [7], given: GIVEN },
			{},
		);

		expect(updated.outcomes[0]?.given).toEqual(GIVEN);
		// And the round says no more than it did, since the reviewers it
		// originally collected did not run under these.
		expect(updated.given).toBeUndefined();
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
		// The same sweep the witness gets, over the same discovery, and
		// for the same reason: the next round kind will be written by
		// somebody who never reads this file, and a fact that reaches
		// four builders out of five is a fact whose absence means
		// nothing. The stack round is not exempt the way it is for the
		// witness: what its reviewers were given is one fact about the
		// whole round however many changes they read.
		//
		// This proves no file grew a builder without growing a reader,
		// and not that each builder carries it, since a file may honestly
		// call it once and spread the result twice. The cases above hold
		// each round to it, the opening record included, which is the one
		// this arithmetic cannot see.
		const builders = roundBuilders();
		for (const { name, source, built } of builders) {
			const carries = source.split("whatItGave(request)").length - 1;
			expect({ name, enough: carries >= built }).toEqual({
				name,
				enough: true,
			});
		}

		expect(builders.map((builder) => builder.name).sort()).toEqual(BUILDERS);
	});
});

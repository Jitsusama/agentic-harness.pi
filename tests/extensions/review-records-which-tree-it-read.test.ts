/**
 * A round that could not read the change says so where it lasts.
 *
 * Since every round began recording the commit under review, a round
 * that fell back to the caller's checkout has recorded one too. The
 * caveat saying which tree was actually read went only to the session
 * that started the round, and vanished with it. What survived was a
 * ledger entry naming a commit the reviewers were never given.
 *
 * That is not a hypothetical. Two councils fell back because a
 * worktree of that name already existed, and between them returned
 * fifty-nine findings formed against whatever the checkout happened
 * to be at the time:
 *
 *   council-20260804T205254160-000001, 7/7 answered, 11 findings
 *   council-20260805T161139435-000001, 7/7 answered, 48 findings
 *
 * The library half is covered where the answer is composed. This is
 * the other half, and the one that was actually missing: the seam
 * between the tree a round got and the record it leaves. Removing the
 * caveat from that join broke nothing anywhere in the suite, which is
 * how the fault existed in the first place.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	readFrom,
	treeForRound,
} from "../../extensions/review-integration/work.js";
import { runCouncil, startCouncil } from "../../lib/review/index.js";

describe("what a round records about the tree it read", () => {
	it("carries the caveat beside the commit, or neither", async () => {
		// The real producer, in the state that produces a caveat with
		// nothing stubbed: no working layer is loaded in a bare test
		// process, so there is nobody to cut a snapshot.
		const tree = await treeForRound(
			{ key: "github:Jitsusama/agentic-harness.pi" },
			"d7205e3c",
			"/the/callers/checkout",
		);

		expect(tree.path).toBe("/the/callers/checkout");
		expect(readFrom(tree, "d7205e3c")).toEqual({
			witness: "d7205e3c",
			unpinned: expect.stringContaining("/the/callers/checkout"),
		});
	});

	it("reaches the run a builder opens, not just the helper", async () => {
		// The helper was tested and the join was not, so the builder a
		// detached round and an interrupted one both go through kept
		// writing the commit alone and nothing said a word. A run that
		// is opened before anybody is asked is the one a later session
		// collects, which is the case this whole change is about.
		const read = readFrom(
			{ path: "/the/callers/checkout", caveat: "read the checkout" },
			"d7205e3c",
		);
		const asking = {
			roster: { reviewers: [{ id: "hawk" }] },
			prompt: "p",
			seq: 1,
			...read,
		};

		// The detached path, which opens a run before anybody answers
		// and writes it to disk. That run is all a later session has.
		const started = await startCouncil(asking, {
			start: async () => {},
			now: () => new Date("2026-08-08T00:00:00.000Z"),
		});
		expect(started.run).toMatchObject({
			witness: "d7205e3c",
			unpinned: "read the checkout",
		});

		// And on the run a finished round hands back, which is a
		// different object built by different code far away from it.
		const { run } = await runCouncil(asking, {
			ask: async () => ({ text: "nothing to report" }),
			now: () => new Date("2026-08-08T00:00:00.000Z"),
			record: async () => [],
		});
		expect(run).toMatchObject({
			witness: "d7205e3c",
			unpinned: "read the checkout",
		});
	});

	it("is passed at every place a round is asked for", () => {
		// The six call sites are the join this file is named for, and
		// three cases against the helper could not see them: the start
		// path passed nothing and the suite stayed green. A scan is a
		// poor test and the right one here, since driving six tools to
		// prove an argument is passed costs more than it tells.
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"..",
				"..",
				"extensions",
				"review-integration",
				"tools",
				"ask.ts",
			),
			"utf8",
		);

		// Every round this tool can start, by the function it calls.
		const rounds = [
			"runCouncil(",
			"startCouncil(",
			"runJudge(",
			"runCritique(",
			"runAudit(",
		];
		// The canary: a round kind this case has not heard of should
		// fail here rather than be skipped silently.
		expect(
			rounds.flatMap((round) => (source.includes(round) ? [round] : [])),
		).toEqual(rounds);

		const passes =
			source.split("readFrom(tree, proposal.headCommit)").length - 1;
		// Six, not five: the retry path asks again and must record what
		// this attempt read, which was the other half of the same fault.
		expect(passes).toBeGreaterThanOrEqual(rounds.length + 1);

		// And that the retry hands it on rather than working it out and
		// dropping it, which is precisely what it did. Making the
		// parameter required stopped the silent omission; it cannot stop
		// a caller passing an empty record, and an empty record is the
		// original bug in a shorter spelling.
		expect(source).toContain("substituteOutcome(held, outcome, read)");
	});

	it("says nothing about a tree that was the commit", () => {
		// A pinned tree has no caveat, and the record should not invent
		// one: absence is what tells a reader the round was faithful.
		expect(readFrom({ path: "/a/snapshot" }, "d7205e3c")).toEqual({
			witness: "d7205e3c",
		});
	});

	it("still says which tree it read when there was no commit to name", () => {
		// A provider that reports no head commit is ordinary. The round
		// is unpinned for a different reason then, and the reason is
		// the half worth keeping.
		expect(
			readFrom({ path: "/x", caveat: "read /x instead" }, undefined),
		).toEqual({ unpinned: "read /x instead" });
	});
});

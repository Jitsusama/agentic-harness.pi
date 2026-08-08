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
	it("refuses when nothing knows where the repo under review lives", async () => {
		// Degrading is right when the fallback is the same repository at
		// some other commit, and catastrophic when it is a different
		// repository altogether. Three councils proved which: asked
		// about a change in one repo from a session sitting in another,
		// they read the session's repo and returned 225 findings about
		// code the change does not contain, for $75.63.
		//
		// A repo with neither a checkout nor a remote is exactly that
		// case, because the thing that makes a fallback plausible, that
		// the caller is sitting in the repo under review, is the same
		// thing that would have given it a local path.
		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			"d7205e3c",
			"/the/callers/checkout",
		);

		expect(tree).toEqual({
			refusal: expect.stringContaining("github:elsewhere/other"),
		});
	});

	it("carries the caveat beside the commit, or neither", async () => {
		// The real producer, in the state that produces a caveat with
		// nothing stubbed: no working layer is loaded in a bare test
		// process, so there is nobody to cut a snapshot. The repo has a
		// local checkout, so the fallback is at worst the right repo at
		// the wrong commit, which is what a caveat is for.
		const tree = await treeForRound(
			{
				key: "github:Jitsusama/agentic-harness.pi",
				localPath: "/the/callers/checkout",
			},
			"d7205e3c",
			"/the/callers/checkout",
		);

		// Narrowed rather than asserted around, so a refusal here fails
		// as a refusal rather than as `false` not being a path.
		if ("refusal" in tree) throw new Error(`refused: ${tree.refusal}`);
		expect(tree.path).toBe("/the/callers/checkout");
		expect(readFrom(tree, "d7205e3c")).toEqual({
			witness: "d7205e3c",
			unpinned: expect.stringContaining("/the/callers/checkout"),
		});
	});

	it("reads the checkout it knows about, not the one it is sitting in", async () => {
		// When a checkout of the right repo is known, that is where a
		// degraded round belongs. It is the right repo by construction,
		// and the caller's own directory is only ever right by luck.
		const tree = await treeForRound(
			{ key: "github:Jitsusama/agentic-harness.pi", localPath: "/the/repo" },
			"d7205e3c",
			"/somewhere/else/entirely",
		);

		if ("refusal" in tree) throw new Error(`refused: ${tree.refusal}`);
		expect(tree.path).toBe("/the/repo");
	});

	it("refuses a repo known only by a remote it cannot cut", async () => {
		// The shape the first attempt let straight through. Knowing a
		// remote says where the repo is on the internet, which is no
		// evidence at all about the directory the caller is sitting in,
		// and that directory was the thing about to be reviewed.
		const tree = await treeForRound(
			{
				key: "github:elsewhere/other",
				remoteUrl: "https://github.com/elsewhere/other.git",
			},
			"d7205e3c",
			"/the/callers/checkout",
		);

		expect(tree).toEqual({
			refusal: expect.stringContaining("not a checkout of"),
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

		// And that every one of them refuses a tree that was refused.
		// The union makes reading a refused tree a compile error, which
		// is most of the guard, but nothing stops a new caller taking
		// the path and never touching it. Counted against the calls
		// rather than fixed at seven, so an eighth round has to answer
		// the question rather than inherit a number.
		const cut = source.split("await treeForRound(").length - 1;
		const refused =
			source.split('if ("refusal" in tree) return refuse(tree.refusal);')
				.length - 1;
		// Both sides counted, because equal counts are satisfied by zero
		// and zero: a rename would take the guard and the calls out
		// together and this would go green on a file that no longer
		// contains the thing it polices.
		expect({ cut, refused }).toEqual({ cut: rounds.length + 2, refused: cut });
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

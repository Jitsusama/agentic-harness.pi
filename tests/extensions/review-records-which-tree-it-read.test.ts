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

import { describe, expect, it } from "vitest";
import {
	readFrom,
	treeForRound,
} from "../../extensions/review-integration/work.js";

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

/**
 * One held tree, as a line in the listing.
 *
 * A snapshot and a worktree are the two intents this layer has, and they want
 * different care: a snapshot is pinned to a commit and shared between readers, a
 * worktree is on a branch with somebody's work in it. The listing drew both with
 * the worktree mark, while the answer that cut a snapshot drew it with the snapshot
 * mark, so the same tree had two appearances depending on which verb spoke.
 */

import { describe, expect, it } from "vitest";
import { GLYPH, treeLine } from "../../extensions/work-integration/render.js";

/** A held tree, with only the fields a line is made of. */
function held(key: string, shareable: boolean) {
	return {
		identity: { key, shareable },
		path: "/somewhere/trees/one",
		providerId: "git-worktree",
	};
}

describe("a held tree as a line", () => {
	it("marks a snapshot as pinned rather than as a place", () => {
		const line = treeLine(held("snapshot-repo-abc123", true));

		expect(line.startsWith(GLYPH.snapshot)).toBe(true);
	});

	it("marks a worktree as a place", () => {
		const line = treeLine(held("worktree-repo-topic", false));

		expect(line.startsWith(GLYPH.tree)).toBe(true);
	});

	it("draws the two differently, which is the whole point", () => {
		// Asserted against each other as well as against the glyphs, so this still
		// fails if both marks are later changed to the same character.
		const snapshot = treeLine(held("snapshot-repo-abc123", true));
		const worktree = treeLine(held("worktree-repo-topic", false));

		expect(snapshot[0]).not.toBe(worktree[0]);
	});

	it("still says which trees this session did not cut", () => {
		// The other distinction on this line, and the reason the first one was worth
		// making: a tree from an earlier session is the one to read status on first.
		const line = treeLine(held("worktree-repo-topic", false), false);

		expect(line).toContain("from an earlier session");
	});
});

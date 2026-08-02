/**
 * A tab is identified by where it sits, not by what it is called.
 *
 * The label was doing two jobs: naming the tab on screen and identifying
 * which item a decision belonged to. That holds only while every label in
 * a batch happens to be unique, and it does not: two top-level comments
 * are both called the same thing, so rejecting one rejected both. The
 * publish gate already carried a dedup helper to dodge this, which was
 * the symptom being treated rather than the cause.
 *
 * It matters more now that a label is a glyph for the kind, because then
 * every reply in a batch shares one.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	confirmBatch,
	type GateItem,
} from "../../extensions/review-integration/gate.js";
import type { PromptResult } from "../../lib/ui/types.js";

/** What both prompts report for a plain Enter. Their sentinel, not ours. */
const SUBMIT = "__enter__";

/** A ctx whose panel answers with whatever the test says it answered. */
function context(answer: unknown) {
	return {
		hasUI: true,
		ui: { setStatus: () => {}, custom: async () => answer },
	} as unknown as ExtensionContext;
}

/** A tabbed answer where the named tabs were acted on. */
function tabbed(decided: Record<number, PromptResult>) {
	return {
		items: new Map(Object.entries(decided).map(([at, r]) => [Number(at), r])),
		userItems: [],
	};
}

/** Three tabs that deliberately share one label, as glyph labels do. */
function sameLabel(): GateItem[] {
	return Array.from({ length: 3 }, () => ({
		label: "\u21b3",
		views: [{ key: "1", label: "Reply", content: () => ["body"] }],
	}));
}

describe("telling two identically labelled tabs apart", () => {
	it("rejects only the tab that was rejected", async () => {
		const ctx = context(tabbed({ 1: { type: "action", key: "r" } }));
		const decision = await confirmBatch(ctx, "Post 3 Things", sameLabel());
		expect(decision.rejected).toEqual([1]);
		expect(decision.accepted).toEqual([0, 2]);
	});

	it("accepts every tab when none is rejected", async () => {
		const ctx = context(tabbed({ 0: { type: "action", key: SUBMIT } }));
		const decision = await confirmBatch(ctx, "Post 3 Things", sameLabel());
		expect(decision.accepted).toEqual([0, 1, 2]);
		expect(decision.rejected).toEqual([]);
	});

	it("says which one it was even when every tab reads alike", async () => {
		const ctx = context(
			tabbed({
				0: { type: "action", key: "r" },
				2: { type: "action", key: "r" },
			}),
		);
		const decision = await confirmBatch(ctx, "Post 3 Things", sameLabel());
		expect(decision.rejected).toEqual([0, 2]);
		expect(decision.accepted).toEqual([1]);
	});
});

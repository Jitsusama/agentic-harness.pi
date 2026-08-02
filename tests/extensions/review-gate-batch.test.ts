/**
 * Several things said at once are approved at once.
 *
 * The shape is the one `slack send_thread` already uses: an array in, a
 * tab per item, one gate for the lot. Answering five council threads used
 * to be five gates, or ten with the settling, and a gate that fires ten
 * times in a row is a gate nobody reads by the fourth.
 *
 * The interesting decision is what an untouched tab means. Slack treats an
 * early submit as a cancel so nothing unseen goes out. This goes the other
 * way: the items were composed in one breath and are all on screen at
 * once, so submitting sends the rest as they stand. A tab explicitly
 * rejected stays rejected. Escape still abandons everything, and so does a
 * redirect, because steering one item means recomposing the batch.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	confirmBatch,
	type GateItem,
	withPosition,
} from "../../extensions/review-integration/gate.js";
import type { PromptResult } from "../../lib/ui/types.js";
import { fakeTheme } from "../lib/ui/fake-theme.js";

/** What both prompts report for a plain Enter. Their sentinel, not ours. */
const SUBMIT = "__enter__";

/** A ctx whose panel answers with whatever the test says it answered. */
function context(answer: unknown, hasUI = true) {
	return {
		hasUI,
		ui: {
			setStatus: () => {},
			custom: async () => answer,
		},
	} as unknown as ExtensionContext;
}

/** A tabbed answer where the named tabs were acted on. */
function tabbed(decided: Record<number, PromptResult>) {
	return {
		items: new Map(Object.entries(decided).map(([at, r]) => [Number(at), r])),
		userItems: [],
	};
}

/** `count` items, labelled the way a threads listing would address them. */
function items(count: number): GateItem[] {
	return Array.from({ length: count }, (_, at) => ({
		label: `T${at + 1}`,
		views: [{ key: "1", label: "Reply", content: () => ["body"] }],
	}));
}

describe("approving several writes at once", () => {
	it("sends a tab that was approved", async () => {
		const ctx = context(tabbed({ 0: { type: "action", key: SUBMIT } }));
		const decision = await confirmBatch(ctx, "Post 2 things?", items(2));
		expect(decision.proceed).toBe(true);
		expect(decision.accepted).toContain("T1");
	});

	it("drops a tab that was rejected, and keeps the rest", async () => {
		const ctx = context(
			tabbed({
				0: { type: "action", key: "r" },
				1: { type: "action", key: SUBMIT },
			}),
		);
		const decision = await confirmBatch(ctx, "Post 2 things?", items(2));
		expect(decision.rejected).toEqual(["T1"]);
		expect(decision.accepted).toEqual(["T2"]);
	});

	it("sends the tabs nobody touched, which is what early submit means here", async () => {
		const ctx = context(tabbed({ 0: { type: "action", key: SUBMIT } }));
		const decision = await confirmBatch(ctx, "Post 3 things?", items(3));
		expect(decision.accepted).toEqual(["T1", "T2", "T3"]);
	});

	it("does not sweep up a tab that was explicitly rejected", async () => {
		const ctx = context(tabbed({ 1: { type: "action", key: "r" } }));
		const decision = await confirmBatch(ctx, "Post 3 things?", items(3));
		expect(decision.accepted).toEqual(["T1", "T3"]);
		expect(decision.rejected).toEqual(["T2"]);
	});

	it("keeps the order they were given in", async () => {
		const ctx = context(tabbed({}));
		const decision = await confirmBatch(ctx, "Post 3 things?", items(3));
		expect(decision.accepted).toEqual(["T1", "T2", "T3"]);
	});

	it("abandons everything on escape", async () => {
		const decision = await confirmBatch(context(null), "Post?", items(3));
		expect(decision.proceed).toBe(false);
		expect(decision.accepted).toEqual([]);
	});

	it("abandons everything on a redirect, and carries what was said", async () => {
		const ctx = context(
			tabbed({
				1: { type: "redirect", note: "answer binks first" },
				0: { type: "action", key: SUBMIT },
			}),
		);
		const decision = await confirmBatch(ctx, "Post 3 things?", items(3));
		expect(decision.proceed).toBe(false);
		expect(decision.accepted).toEqual([]);
		expect(decision.redirect).toContain("answer binks first");
	});

	it("keeps a note left on a rejection, without stopping the others", async () => {
		const ctx = context(
			tabbed({ 0: { type: "action", key: "r", note: "wrong thread" } }),
		);
		const decision = await confirmBatch(ctx, "Post 2 things?", items(2));
		expect(decision.proceed).toBe(true);
		expect(decision.redirect).toContain("wrong thread");
	});
});

describe("a batch of one", () => {
	it("asks as a single panel, so the simple case gains no ceremony", async () => {
		// A single prompt answers with a PromptResult rather than a tab map.
		const ctx = context({ type: "action", key: SUBMIT });
		const decision = await confirmBatch(ctx, "Post this reply?", items(1));
		expect(decision.proceed).toBe(true);
		expect(decision.accepted).toEqual(["T1"]);
	});

	it("refuses the one item when it is rejected", async () => {
		const ctx = context({ type: "action", key: "r" });
		const decision = await confirmBatch(ctx, "Post this reply?", items(1));
		expect(decision.proceed).toBe(false);
		expect(decision.rejected).toEqual(["T1"]);
	});
});

describe("knowing where you are in a batch", () => {
	/** Every line the tab at `at` draws, across all of its views. */
	function viewsOf(placed: GateItem[], at: number) {
		return (placed[at]?.views ?? []).flatMap((view) =>
			view.content(fakeTheme(), 72),
		);
	}

	it("opens each tab by saying which of how many it is", () => {
		const placed = withPosition(items(3));
		expect(viewsOf(placed, 0)[0]).toContain("1 of 3");
		expect(viewsOf(placed, 2)[0]).toContain("3 of 3");
	});

	it("says it on every view, since only one is on screen at a time", () => {
		const placed = withPosition([
			{
				label: "V",
				views: [
					{ key: "1", label: "Review", content: () => ["verdict"] },
					{ key: "2", label: "F1", content: () => ["a remark"] },
				],
			},
			{
				label: "T2",
				views: [{ key: "1", label: "Reply", content: () => ["x"] }],
			},
		]);
		const drawn = viewsOf(placed, 0);
		expect(drawn.filter((line) => line.includes("1 of 2"))).toHaveLength(2);
	});

	it("keeps the content itself, below the line", () => {
		expect(viewsOf(withPosition(items(2)), 0)).toContain("body");
	});

	it("says nothing about position when there is only one thing", () => {
		// One item is not a batch, and "1 of 1" is noise on a panel whose
		// whole job is to be read.
		expect(viewsOf(withPosition(items(1)), 0)).toEqual(["body"]);
	});
});

describe("with nobody to ask", () => {
	it("approves everything, as every gate in this package does headless", async () => {
		const ctx = context(null, false);
		const decision = await confirmBatch(ctx, "Post 3 things?", items(3));
		expect(decision.proceed).toBe(true);
		expect(decision.accepted).toEqual(["T1", "T2", "T3"]);
	});
});

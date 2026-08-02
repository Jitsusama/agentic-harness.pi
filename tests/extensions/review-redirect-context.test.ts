/**
 * A steer is only actionable next to the thing being steered away from.
 *
 * Found by driving the live tool rather than by a test, which is the
 * point worth recording. `review_say` answered a redirect with the bare
 * note and nothing else, so the model was told "say it plainer" with no
 * record of what it had said. The single-gate path had always quoted the
 * panel back; the batch path, written later, never called the function
 * that does it.
 *
 * The renderer tests could not see this. They pin what `gateText`
 * produces, and the gap was that nothing on this path called it. That is
 * a wiring fault, and wiring is what the live pass is for.
 *
 * A batch quotes only the tab that was redirected. Handing back five
 * panels when one was objected to buries the objection.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	confirmBatch,
	type GateItem,
} from "../../extensions/review-integration/gate.js";
import type { PromptResult } from "../../lib/ui/types.js";

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

/** Items that each carry the plain text of their own panel. */
function items(count: number): GateItem[] {
	return Array.from({ length: count }, (_, at) => ({
		label: "\u21b3",
		plain: `panel ${at + 1}: the body being sent`,
		views: [{ key: "1", label: "Reply", content: () => ["body"] }],
	}));
}

describe("what a redirect hands back", () => {
	it("carries the steer, which is the instruction", async () => {
		const ctx = context(
			tabbed({ 0: { type: "redirect", note: "say it plainer" } }),
		);
		const decision = await confirmBatch(ctx, "Post 2 Things", items(2));
		expect(decision.redirect).toContain("say it plainer");
	});

	it("carries the panel it was steering away from", async () => {
		const ctx = context(
			tabbed({ 0: { type: "redirect", note: "say it plainer" } }),
		);
		const decision = await confirmBatch(ctx, "Post 2 Things", items(2));
		expect(decision.redirect).toContain("panel 1: the body being sent");
	});

	it("quotes the tab that was objected to, not the whole batch", async () => {
		const ctx = context(
			tabbed({ 1: { type: "redirect", note: "wrong thread" } }),
		);
		const decision = await confirmBatch(ctx, "Post 3 Things", items(3));
		expect(decision.redirect).toContain("panel 2");
		expect(decision.redirect).not.toContain("panel 1");
		expect(decision.redirect).not.toContain("panel 3");
	});

	it("does the same for a lone item, which is asked as a plain panel", async () => {
		const ctx = context({ type: "redirect", note: "answer binks first" });
		const decision = await confirmBatch(ctx, "Post This Reply", items(1));
		expect(decision.redirect).toContain("answer binks first");
		expect(decision.redirect).toContain("panel 1: the body being sent");
	});

	it("still sends nothing when it redirects", async () => {
		const ctx = context(tabbed({ 0: { type: "redirect", note: "no" } }));
		const decision = await confirmBatch(ctx, "Post 2 Things", items(2));
		expect(decision.proceed).toBe(false);
		expect(decision.accepted).toEqual([]);
	});

	it("says the steer alone when the caller offered no panel text", async () => {
		// Nothing to quote is not a reason to lose the instruction.
		const bare: GateItem[] = [
			{
				label: "\u21b3",
				views: [{ key: "1", label: "R", content: () => ["x"] }],
			},
		];
		const ctx = context({ type: "redirect", note: "try again" });
		const decision = await confirmBatch(ctx, "Post This Reply", bare);
		expect(decision.redirect).toContain("try again");
	});
});

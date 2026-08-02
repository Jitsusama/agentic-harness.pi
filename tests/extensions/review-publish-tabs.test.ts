/**
 * The gate that sends the most used to show the least.
 *
 * Publishing rendered `planNarration`: op counts and raw thread uuids,
 * with not one word of the text about to go on somebody else's change. A
 * person approving it was approving a number.
 *
 * Now every operation gets a tab and every tab shows its payload whole,
 * with the plan still leading so the summary is read first. Tabs come
 * from operations rather than draft items because an operation is what
 * will actually be sent: the review carries several remarks in one
 * request, so each remark is a view on that tab rather than a tab whose
 * rejection the backend could not honour.
 */

import { describe, expect, it } from "vitest";
import {
	PLAN_TAB,
	publishTabs,
} from "../../extensions/review-integration/tools/publish-gate.js";
import type { PublishPlan, Thread } from "../../lib/review/index.js";
import { plainTheme } from "../lib/ui/fake-theme.js";

const HERE = "shop/world#2000980 \u00b7 meteorite";

/** A thread anchored at a line, with one remark in it. */
function thread(id: string, line: number): Thread {
	return {
		id,
		resolved: false,
		anchor: { subject: "line", path: "pkg/policy.go", line, blob: "new" },
		comments: [{ id: `c-${id}`, author: { id: "binks" }, body: "have a look" }],
	} as unknown as Thread;
}

/** A plan carrying the ops given. */
function planOf(...ops: unknown[]): PublishPlan {
	return { ops, degraded: [], refused: [] } as unknown as PublishPlan;
}

/** Everything drawn on one tab, across all of its views. */
function drawn(tab: { item: { views: { content: unknown }[] } }): string {
	return tab.item.views
		.flatMap((view) =>
			(view.content as (t: unknown, w: number) => string[])(plainTheme(), 72),
		)
		.join("\n");
}

describe("what the publish gate puts on screen", () => {
	it("leads with the plan, so the summary is still read first", () => {
		const tabs = publishTabs(
			planOf({ kind: "comment", body: "thanks all", itemIds: ["1"] }),
			HERE,
			undefined,
		);
		expect(tabs[0]?.summary).toBe(true);
		expect(tabs[0]?.item.label).toBe("\u2261");
	});

	it("marks only the summary as the summary, since it stands for the lot", () => {
		// Rejecting it across a stack drops the whole change, so it is a
		// flag rather than a label somebody could collide with.
		const tabs = publishTabs(
			planOf(
				{ kind: "comment", body: "a", itemIds: ["1"] },
				{ kind: "comment", body: "b", itemIds: ["2"] },
			),
			HERE,
			undefined,
		);
		expect(tabs.filter((tab) => tab.summary)).toHaveLength(1);
		expect(PLAN_TAB).toBe("Plan");
	});

	it("gives every operation a tab of its own", () => {
		const tabs = publishTabs(
			planOf(
				{
					kind: "reply",
					thread: thread("t1", 10),
					body: "fixed",
					itemIds: ["1"],
				},
				{ kind: "resolve", thread: thread("t2", 20), itemIds: ["2"] },
			),
			HERE,
			undefined,
		);
		expect(tabs).toHaveLength(3);
	});

	it("shows the words being sent, which is the whole point", () => {
		const tabs = publishTabs(
			planOf({
				kind: "reply",
				thread: thread("t1", 10),
				body: "Fixed in 0671cb0.",
				itemIds: ["1"],
			}),
			HERE,
			undefined,
		);
		expect(drawn(tabs[1] as never)).toContain("Fixed in 0671cb0.");
	});

	it("names the change on every tab, since a session may hold two", () => {
		const tabs = publishTabs(
			planOf({ kind: "comment", body: "thanks", itemIds: ["1"] }),
			HERE,
			undefined,
		);
		expect(drawn(tabs[1] as never)).toContain("shop/world#2000980");
	});

	it("gives the review a view per remark, so all of them can be read", () => {
		const tabs = publishTabs(
			planOf({
				kind: "review",
				verdict: "request-changes",
				body: "two things",
				comments: [
					{
						anchor: { subject: "line", path: "a.go", line: 1, blob: "new" },
						body: "first remark",
					},
					{
						anchor: { subject: "line", path: "b.go", line: 2, blob: "new" },
						body: "second remark",
					},
				],
				itemIds: ["1", "2", "3"],
			}),
			HERE,
			undefined,
		);
		const review = tabs[1];
		expect(review?.item.label).toBe("\u25bd");
		expect(review?.item.views.map((one) => one.label)).toEqual([
			"Review",
			"F1",
			"F2",
		]);
		expect(drawn(review as never)).toContain("first remark");
		expect(drawn(review as never)).toContain("second remark");
	});

	it("carries the items behind each tab, so rejecting one can drop them", () => {
		const tabs = publishTabs(
			planOf({ kind: "resolve", thread: thread("t2", 20), itemIds: ["7"] }),
			HERE,
			undefined,
		);
		expect(tabs[1]?.itemIds).toEqual(["7"]);
		// Rejecting the plan tab rejects the publish, and drops nothing.
		expect(tabs[0]?.itemIds).toEqual([]);
	});

	it("lets two replies wear the same mark, and keeps their items apart", () => {
		// This used to be the opposite test, with a helper that appended a
		// number so no two labels matched. The dedup existed because a
		// decision was matched by label, so a shared name dropped both
		// tabs. Decisions are positions now, so the mark is free to say
		// what the thing is rather than which one it is.
		const tabs = publishTabs(
			planOf(
				{ kind: "reply", thread: thread("t1", 10), body: "a", itemIds: ["1"] },
				{ kind: "reply", thread: thread("t2", 10), body: "b", itemIds: ["2"] },
			),
			HERE,
			undefined,
		);
		expect(tabs[1]?.item.label).toBe(tabs[2]?.item.label);
		expect(tabs[1]?.itemIds).toEqual(["1"]);
		expect(tabs[2]?.itemIds).toEqual(["2"]);
	});
});

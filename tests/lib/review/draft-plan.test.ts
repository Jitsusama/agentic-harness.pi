import { describe, expect, it } from "vitest";
import {
	addFinding,
	addReaction,
	addReply,
	addResolution,
	type ConversationCapabilities,
	compilePlan,
	type DraftState,
	emptyDraft,
	type LineAnchor,
	type PlanContext,
	parseUnifiedDiff,
	type ReviewTarget,
	setVerdict,
	type Thread,
} from "../../../lib/review";

const target: ReviewTarget = {
	kind: "proposal",
	change: {
		provider: "meteorite",
		repo: { key: "gitstream:shop/world" },
		id: "2000970",
		label: "shop/world#2000970",
	},
};

const diff = parseUnifiedDiff(`diff --git a/lib/app.ts b/lib/app.ts
index 83db48f..bf269f4 100644
--- a/lib/app.ts
+++ b/lib/app.ts
@@ -1,3 +1,4 @@
 const one = 1;
-const two = 2;
+const two = "two";
+const three = 3;
 const four = 4;
`);

/** Everything a well-appointed forge can do. */
const fullConversation: ConversationCapabilities = {
	anchoredBatchReview: true,
	fileLevelComments: "batch",
	multiLineRanges: true,
	suggestions: true,
	unresolve: true,
	reactions: ["+1", "rocket", "eyes"],
	topLevelThreading: false,
	pendingReviews: true,
	staleness: "pinned",
};

function context(
	overrides: Partial<ConversationCapabilities> = {},
	extra: Partial<PlanContext> = {},
): PlanContext {
	return {
		capabilities: {
			conversation: { ...fullConversation, ...overrides },
		},
		...extra,
	};
}

const onNewLine: LineAnchor = {
	subject: "line",
	path: "lib/app.ts",
	blob: "new",
	line: 3,
};

const thread: Thread = {
	id: "t1",
	resolved: false,
	comments: [{ id: "c1", author: { id: "someone" }, body: "why?" }],
};

function draft(): DraftState {
	return emptyDraft("d1", target);
}

describe("compilePlan", () => {
	it("plans nothing for an empty draft", () => {
		const plan = compilePlan(draft(), context());
		expect(plan.ops).toEqual([]);
		expect(plan.degraded).toEqual([]);
		expect(plan.refused).toEqual([]);
	});

	it("carries the target so a plan can be read on its own", () => {
		expect(compilePlan(draft(), context()).target).toEqual(target);
	});

	it("batches findings and the verdict into one review", () => {
		let state = addFinding(draft(), { anchor: onNewLine, body: "leaks" });
		state = setVerdict(state, "request-changes", "one thing");
		const plan = compilePlan(state, context());
		expect(plan.ops).toHaveLength(1);
		const [op] = plan.ops;
		expect(op.kind).toBe("review");
		expect(op.kind === "review" && op.verdict).toBe("request-changes");
		expect(op.kind === "review" && op.comments).toHaveLength(1);
		expect(op.kind === "review" && op.body).toContain("one thing");
	});

	it("treats a review with no verdict as taking no position", () => {
		const state = addFinding(draft(), { anchor: onNewLine, body: "leaks" });
		const [op] = compilePlan(state, context()).ops;
		expect(op.kind === "review" && op.verdict).toBe("comment");
	});

	it("plans a verdict with no findings as a review all the same", () => {
		const state = setVerdict(draft(), "approve", "looks right");
		const [op] = compilePlan(state, context()).ops;
		expect(op.kind).toBe("review");
		expect(op.kind === "review" && op.comments).toEqual([]);
	});

	it("plans replies, resolutions and reactions as their own operations", () => {
		let state = addReply(draft(), thread, "because of the retry");
		state = addResolution(state, thread);
		state = addReaction(state, thread.comments[0], "rocket");
		const plan = compilePlan(state, context());
		expect(plan.ops.map((op) => op.kind)).toEqual([
			"reply",
			"resolve",
			"react",
		]);
	});

	it("puts the review first so its comments exist before replies", () => {
		let state = addReply(draft(), thread, "context");
		state = addFinding(state, { anchor: onNewLine, body: "leaks" });
		const plan = compilePlan(state, context());
		expect(plan.ops.map((op) => op.kind)).toEqual(["review", "reply"]);
	});

	it("names the item each operation came from", () => {
		const state = addReply(draft(), thread, "context");
		const [op] = compilePlan(state, context()).ops;
		expect(op.itemIds).toEqual(["1"]);
	});

	describe("when an anchor cannot land", () => {
		const offDiff: LineAnchor = {
			subject: "line",
			path: "lib/app.ts",
			blob: "new",
			line: 99,
		};

		it("moves the finding into the review body and says why", () => {
			const state = addFinding(draft(), {
				anchor: offDiff,
				body: "this is wrong",
			});
			const plan = compilePlan(state, context({}, { diff }));
			const [op] = plan.ops;
			expect(op.kind === "review" && op.comments).toEqual([]);
			expect(op.kind === "review" && op.body).toContain("this is wrong");
			expect(op.kind === "review" && op.body).toContain("lib/app.ts");
			expect(plan.degraded).toHaveLength(1);
			expect(plan.degraded[0].itemId).toBe("1");
			expect(plan.degraded[0].reason).toMatch(/line-absent/);
		});

		it("keeps a spilled remark whole when its text runs to several lines", () => {
			// Every remark worth making is more than one line: a header,
			// a blank, then the reasoning. Indenting only the first line
			// ends the list at the blank, and the rest reads as loose
			// prose belonging to nobody.
			const state = addFinding(draft(), {
				anchor: offDiff,
				body: "**issue:** it leaks\n\nThe handle is never closed.",
			});

			const plan = compilePlan(state, context({}, { diff }));
			const [op] = plan.ops;
			if (op.kind !== "review") throw new Error("expected a review op");

			const tail = op.body
				.split("\n")
				.find((line) => line.includes("The handle is never closed"));
			expect(tail).toBeDefined();
			expect(tail?.startsWith(" ")).toBe(true);
		});

		it("trusts the anchor when no diff was supplied to check against", () => {
			const state = addFinding(draft(), { anchor: offDiff, body: "x" });
			const plan = compilePlan(state, context());
			expect(plan.degraded).toEqual([]);
			const [op] = plan.ops;
			expect(op.kind === "review" && op.comments).toHaveLength(1);
		});
	});

	describe("against a provider with narrower capabilities", () => {
		it("collapses a multi-line range to its last line", () => {
			const state = addFinding(draft(), {
				anchor: { ...onNewLine, startLine: 1 },
				body: "this block",
			});
			const plan = compilePlan(state, context({ multiLineRanges: false }));
			const [op] = plan.ops;
			const comment = op.kind === "review" ? op.comments[0] : undefined;
			expect(comment?.anchor.subject === "line" && comment.anchor.line).toBe(3);
			expect(
				comment?.anchor.subject === "line" && comment.anchor.startLine,
			).toBeUndefined();
			expect(plan.degraded[0].reason).toMatch(/range/i);
		});

		it("moves a file-level remark into the body when there is nowhere else", () => {
			const state = addFinding(draft(), {
				anchor: { subject: "file", path: "lib/app.ts" },
				body: "whole file problem",
			});
			const plan = compilePlan(state, context({ fileLevelComments: "never" }));
			const [op] = plan.ops;
			expect(op.kind === "review" && op.comments).toEqual([]);
			expect(op.kind === "review" && op.body).toContain("whole file problem");
			expect(plan.degraded).toHaveLength(1);
		});

		it("posts a file-level remark on its own where a batch will not take it", () => {
			// Both backends surveyed reject an entire review that contains one
			// of these while accepting the same remark posted alone, so this is
			// what stops one file-level remark costing every remark beside it.
			let state = addFinding(draft(), {
				anchor: onNewLine,
				body: "this line",
			});
			state = addFinding(state, {
				anchor: { subject: "file", path: "lib/app.ts" },
				body: "whole file problem",
			});

			const plan = compilePlan(
				state,
				context({ fileLevelComments: "standalone" }),
			);

			const review = plan.ops.find((op) => op.kind === "review");
			const alone = plan.ops.find((op) => op.kind === "commentOn");
			expect(review?.kind === "review" && review.comments).toHaveLength(1);
			expect(alone?.kind === "commentOn" && alone.comment.body).toBe(
				"whole file problem",
			);
			// The review body does not also carry it, or it would be said twice.
			expect(review?.kind === "review" && review.body).not.toContain(
				"whole file problem",
			);
		});

		it("calls that no degradation, since nothing about the remark changed", () => {
			// It lands where it was aimed, said by the same person about the same
			// file. Which request carries it is the provider's business.
			const state = addFinding(draft(), {
				anchor: { subject: "file", path: "lib/app.ts" },
				body: "whole file problem",
			});

			const plan = compilePlan(
				state,
				context({ fileLevelComments: "standalone" }),
			);

			expect(plan.degraded).toEqual([]);
		});

		it("posts nothing but the remark when there is nothing else to say", () => {
			// An empty review beside it would be a message saying nothing.
			const state = addFinding(draft(), {
				anchor: { subject: "file", path: "lib/app.ts" },
				body: "whole file problem",
			});

			const plan = compilePlan(
				state,
				context({ fileLevelComments: "standalone" }),
			);

			expect(plan.ops).toHaveLength(1);
			expect(plan.ops[0]?.kind).toBe("commentOn");
		});

		it("spills comments past the batch cap into the body", () => {
			let state = draft();
			for (let n = 0; n < 3; n++) {
				state = addFinding(state, { anchor: onNewLine, body: `note ${n}` });
			}
			const plan = compilePlan(state, context({ maxBatchComments: 2 }));
			const [op] = plan.ops;
			expect(op.kind === "review" && op.comments).toHaveLength(2);
			expect(op.kind === "review" && op.body).toContain("note 2");
			expect(plan.degraded).toHaveLength(1);
			expect(plan.degraded[0].reason).toMatch(/cap|limit/i);
		});

		it("inlines every finding when the provider cannot batch anchors", () => {
			const state = addFinding(draft(), {
				anchor: onNewLine,
				body: "inline me",
			});
			const plan = compilePlan(state, context({ anchoredBatchReview: false }));
			const [op] = plan.ops;
			expect(op.kind).toBe("comment");
			expect(op.kind === "comment" && op.body).toContain("inline me");
			expect(plan.degraded).toHaveLength(1);
		});

		it("refuses a reaction the provider does not accept", () => {
			const state = addReaction(draft(), thread.comments[0], "hooray");
			const plan = compilePlan(state, context());
			expect(plan.ops).toEqual([]);
			expect(plan.refused).toHaveLength(1);
			expect(plan.refused[0].reason).toMatch(/hooray/);
		});

		it("refuses every reaction when the provider has none", () => {
			const state = addReaction(draft(), thread.comments[0], "rocket");
			const plan = compilePlan(state, context({ reactions: [] }));
			expect(plan.refused).toHaveLength(1);
		});
	});

	describe("when the conversation has nowhere to go", () => {
		it("refuses everything and says the target has no host", () => {
			let state = addFinding(draft(), { anchor: onNewLine, body: "x" });
			state = addReply(state, thread, "y");
			const plan = compilePlan(state, { capabilities: {} });
			expect(plan.ops).toEqual([]);
			expect(plan.refused).toHaveLength(2);
			expect(plan.refused[0].reason).toMatch(/no conversation/i);
		});
	});

	describe("verdict rules the provider declares", () => {
		it("refuses a verdict that needs a summary it does not have", () => {
			const state = setVerdict(draft(), "request-changes");
			const plan = compilePlan(
				state,
				context({ bodyRequiredFor: ["request-changes"] }),
			);
			expect(plan.ops).toEqual([]);
			expect(plan.refused[0].reason).toMatch(/summary/i);
		});

		it("refuses a verdict the actor may not give on their own change", () => {
			const state = setVerdict(draft(), "approve", "self five");
			const plan = compilePlan(
				state,
				context({ selfVerdicts: ["comment"] }, { ownChange: true }),
			);
			expect(plan.refused[0].reason).toMatch(/own change/i);
		});

		it("refuses a verdict no longer allowed once merged", () => {
			const state = setVerdict(draft(), "approve", "late");
			const plan = compilePlan(
				state,
				context({ verdictsAfterMerge: ["comment"] }, { changeState: "merged" }),
			);
			expect(plan.refused[0].reason).toMatch(/merged/i);
		});

		it("still plans the findings when only the verdict is refused", () => {
			let state = addFinding(draft(), { anchor: onNewLine, body: "note" });
			state = setVerdict(state, "request-changes");
			const plan = compilePlan(
				state,
				context({ bodyRequiredFor: ["request-changes"] }),
			);
			const [op] = plan.ops;
			expect(op.kind === "review" && op.verdict).toBe("comment");
			expect(plan.refused).toHaveLength(1);
		});
	});

	describe("resolutions", () => {
		it("refuses to resolve a thread that is already resolved", () => {
			const state = addResolution(draft(), { ...thread, resolved: true });
			const plan = compilePlan(state, context());
			expect(plan.ops).toEqual([]);
			expect(plan.refused[0].reason).toMatch(/already resolved/i);
		});
	});
});

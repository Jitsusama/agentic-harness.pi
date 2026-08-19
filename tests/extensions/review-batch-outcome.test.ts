/**
 * What a batch says happened, once it has happened.
 *
 * The interesting case is the one that half landed. Operations run in the
 * order the batch put them and a failure does not stop the ones after it,
 * because the alternative is a batch posted with some of its replies
 * missing and no record of which. So the answer is per item, and a
 * failure is reported beside the ones that worked rather than thrown over
 * the top of them.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	BoundTarget,
	Thread,
} from "@jitsusama/agentic-harness.core/review";
import { describe, expect, it } from "vitest";
import { runBatch } from "../../extensions/review-integration/tools/batch.js";

/** A ctx whose gate approves everything, as it does with nobody to ask. */
const HEADLESS = { hasUI: false, ui: {} } as unknown as ExtensionContext;

/** A ctx whose gate rejects the tab with this label. */
function rejecting(label: string): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			setStatus: () => {},
			custom: async () => ({
				items: new Map([[labelIndex(label), { type: "action", key: "r" }]]),
				userItems: [],
			}),
		},
	} as unknown as ExtensionContext;
}

/** Which tab a label is, given the threads these tests use. */
function labelIndex(label: string): number {
	return Number(label.slice(1)) - 1;
}

const CHANGE = { label: "shop/world#1", provider: "meteorite" } as never;
const BOUND = {
	provider: { id: "meteorite" },
	capabilities: { conversation: { reactions: [] } },
} as unknown as BoundTarget;

/** Three open threads, addressed T1 to T3. */
const THREADS = [1, 2, 3].map(
	(n) =>
		({
			id: `t${n}`,
			resolved: false,
			comments: [{ id: `c${n}`, author: { id: "binks" }, body: "have a look" }],
		}) as unknown as Thread,
);

/** A conversation that records replies and can be told to fail on one. */
function conversation(failOn?: string) {
	const replied: string[] = [];
	return {
		replied,
		facet: {
			async reply(_change: unknown, thread: Thread) {
				if (thread.id === failOn) throw new Error("upstream said no");
				replied.push(thread.id);
				return { url: `https://example.test/${thread.id}` };
			},
			async resolve() {},
		} as never,
	};
}

/** Reply to every thread. */
const REPLIES = [1, 2, 3].map((n) => ({
	action: "reply",
	thread: n,
	body: `answer ${n}`,
}));

/** The answer as one string. */
function said(answer: { content: { text?: string }[] }): string {
	return answer.content.map((one) => one.text ?? "").join("\n");
}

describe("what a batch reports", () => {
	it("names every item it posted", async () => {
		const { facet, replied } = conversation();
		const answer = await runBatch(
			HEADLESS,
			BOUND,
			facet,
			CHANGE,
			THREADS,
			REPLIES,
		);
		expect(replied).toEqual(["t1", "t2", "t3"]);
		for (const label of ["T1", "T2", "T3"]) {
			expect(said(answer as never)).toContain(label);
		}
	});

	it("carries on past a failure, and says which one failed", async () => {
		const { facet, replied } = conversation("t2");
		const answer = await runBatch(
			HEADLESS,
			BOUND,
			facet,
			CHANGE,
			THREADS,
			REPLIES,
		);
		// The third still went, which is the whole reason for not throwing.
		expect(replied).toEqual(["t1", "t3"]);
		const text = said(answer as never);
		expect(text).toContain("T2 failed");
		expect(text).toContain("upstream said no");
	});

	it("says a rejected item was dropped rather than silently skipping it", async () => {
		const { facet, replied } = conversation();
		const answer = await runBatch(
			rejecting("T2"),
			BOUND,
			facet,
			CHANGE,
			THREADS,
			REPLIES,
		);
		expect(replied).toEqual(["t1", "t3"]);
		expect(said(answer as never)).toContain("T2 dropped");
	});

	it("refuses the whole batch before posting when one entry cannot be read", async () => {
		const { facet, replied } = conversation();
		const answer = await runBatch(HEADLESS, BOUND, facet, CHANGE, THREADS, [
			{ action: "reply", thread: 1, body: "fine" },
			{ action: "reply", thread: 2 },
		]);
		// Nothing at all, including the entry that was fine: finding out
		// halfway through would leave the first one posted.
		expect(replied).toEqual([]);
		expect(said(answer as never)).toContain("needs a body");
	});

	it("refuses a thread nobody can point at, naming the address", async () => {
		const { facet } = conversation();
		const answer = await runBatch(HEADLESS, BOUND, facet, CHANGE, THREADS, [
			{ action: "reply", thread: 9, body: "hello" },
		]);
		expect(said(answer as never)).toContain("[T9]");
	});
});

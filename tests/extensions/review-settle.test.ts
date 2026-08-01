/**
 * Answering a thread and closing it is one intent, so it costs one call.
 *
 * It used to cost two, because settling was its own action: five council
 * threads answered and closed was ten gates. The reply now carries what to
 * do with the thread afterwards, preset by whoever composed it, so nobody
 * at the keyboard has to decide it twice.
 *
 * Order matters and so does honesty about it. The reply goes first, because
 * a thread closed around a reply that never landed is worse than a reply
 * sitting in an open thread. When the settle fails behind a reply that did
 * land, the answer says exactly that: claiming the pair succeeded is a lie,
 * and claiming it failed loses a comment somebody can now see.
 */

import { describe, expect, it } from "vitest";
import {
	settleAfter,
	settleRefusal,
} from "../../extensions/review-integration/tools/settle.js";

/** A conversation that records what it was asked, and can be told to fail. */
function conversation(failing?: "resolve" | "unresolve") {
	const calls: string[] = [];
	return {
		calls,
		facet: {
			async resolve() {
				calls.push("resolve");
				if (failing === "resolve") throw new Error("upstream said no");
			},
			async unresolve() {
				calls.push("unresolve");
				if (failing === "unresolve") throw new Error("upstream said no");
			},
		},
	};
}

const CHANGE = { label: "shop/world#1" } as never;
const THREAD = { id: "t1" } as never;

describe("settling a thread behind a reply", () => {
	it("resolves it when asked", async () => {
		const { calls, facet } = conversation();
		const outcome = await settleAfter(facet, CHANGE, THREAD, "resolve");
		expect(calls).toEqual(["resolve"]);
		expect(outcome.settled).toBe(true);
		expect(outcome.note).toContain("resolved");
	});

	it("reopens it when asked", async () => {
		const { calls, facet } = conversation();
		const outcome = await settleAfter(facet, CHANGE, THREAD, "unresolve");
		expect(calls).toEqual(["unresolve"]);
		expect(outcome.settled).toBe(true);
		expect(outcome.note).toContain("reopened");
	});

	it("touches nothing when told to leave it", async () => {
		const { calls, facet } = conversation();
		const outcome = await settleAfter(facet, CHANGE, THREAD, "leave");
		expect(calls).toEqual([]);
		expect(outcome.settled).toBe(false);
		expect(outcome.note).toBeUndefined();
	});

	it("treats an omitted settle exactly as leaving it", async () => {
		const { calls, facet } = conversation();
		const outcome = await settleAfter(facet, CHANGE, THREAD, undefined);
		expect(calls).toEqual([]);
		expect(outcome).toEqual(await settleAfter(facet, CHANGE, THREAD, "leave"));
	});

	it("reports both facts when the settle fails behind a landed reply", async () => {
		const { facet } = conversation("resolve");
		const outcome = await settleAfter(facet, CHANGE, THREAD, "resolve");
		expect(outcome.settled).toBe(false);
		// Both halves, because either one alone misleads.
		expect(outcome.note).toContain("upstream said no");
		expect(outcome.note).toContain("still open");
	});
});

describe("refusing before anything is posted", () => {
	it("refuses an unresolve a provider cannot do", () => {
		expect(
			settleRefusal({ resolve: async () => {} }, "unresolve", "meteorite"),
		).toContain("meteorite");
	});

	it("allows an unresolve a provider can do", () => {
		expect(
			settleRefusal(
				{ resolve: async () => {}, unresolve: async () => {} },
				"unresolve",
				"meteorite",
			),
		).toBeUndefined();
	});

	it("has nothing to say about leaving a thread alone", () => {
		expect(
			settleRefusal({ resolve: async () => {} }, "leave", "meteorite"),
		).toBeUndefined();
	});
});

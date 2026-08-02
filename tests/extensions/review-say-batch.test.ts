/**
 * Saying several things at once, and saying them once.
 *
 * The singular parameters are the one-item shorthand, so a call carrying
 * both them and the array has said the same thing twice and the two can
 * disagree. Refused rather than resolved by precedence: a rule about which
 * one wins is a rule somebody has to know, and getting it wrong posts the
 * other one.
 *
 * Tabs are addressed the way the listing that produced them was addressed.
 * Reading `[T26]` in a gate and `[T26]` in a threads listing has to mean
 * the same thread, or the address is decoration.
 */

import { describe, expect, it } from "vitest";
import {
	addressOf,
	batchRefusal,
	glyphOf,
} from "../../extensions/review-integration/tools/batch.js";

describe("refusing a batch that cannot be read", () => {
	it("allows the array on its own", () => {
		expect(
			batchRefusal({ items: [{ action: "reply", thread: 26, body: "yes" }] }),
		).toBeUndefined();
	});

	it("allows the singular parameters on their own", () => {
		expect(batchRefusal({ action: "reply", thread: 26, body: "yes" })).toBe(
			undefined,
		);
	});

	it("refuses both together, and says which to drop", () => {
		const refusal = batchRefusal({
			action: "reply",
			thread: 26,
			body: "yes",
			items: [{ action: "reply", thread: 27, body: "also yes" }],
		});
		expect(refusal).toContain("items");
		expect(refusal).toContain("Drop the singular");
	});

	it("ignores the change and repo, which say where rather than what", () => {
		// Naming the change alongside a batch is not saying anything twice.
		expect(
			batchRefusal({
				change: "shop/world#1",
				repo: "/src/world",
				items: [{ action: "reply", thread: 26, body: "yes" }],
			}),
		).toBeUndefined();
	});

	it("refuses an empty array rather than gating nothing", () => {
		expect(batchRefusal({ items: [] })).toContain("empty");
	});

	it("refuses an entry with no action, naming which one", () => {
		const refusal = batchRefusal({
			items: [{ action: "reply", thread: 1, body: "a" }, { body: "b" }],
		});
		expect(refusal).toContain("2");
		expect(refusal).toContain("action");
	});

	it("does not let the top-level action stand in for a missing one", () => {
		// Otherwise a batch of replies with one stray entry silently becomes
		// a reply nobody wrote.
		expect(batchRefusal({ action: "reply", items: [{ body: "b" }] })).toContain(
			"action",
		);
	});
});

describe("addressing each entry the way its listing did", () => {
	it("addresses a reply by its thread", () => {
		expect(addressOf({ action: "reply", thread: 26, body: "x" }, 0)).toBe(
			"T26",
		);
	});

	it("addresses a resolve and a reopen by their thread too", () => {
		expect(addressOf({ action: "resolve", thread: 4 }, 0)).toBe("T4");
		expect(addressOf({ action: "unresolve", thread: 4 }, 0)).toBe("T4");
	});

	it("addresses a reaction by the comment it lands on", () => {
		expect(
			addressOf({ action: "react", comment: "C4", reaction: "rocket" }, 0),
		).toBe("C4");
	});

	it("addresses an annotation by where it points", () => {
		expect(
			addressOf({ action: "annotate", path: "pkg/policy.go", line: 166 }, 0),
		).toBe("policy.go:166");
	});

	it("addresses a top-level comment by what it is", () => {
		expect(addressOf({ action: "comment", body: "thanks all" }, 0)).toBe(
			"the comment",
		);
	});

	it("falls back to the position when an entry names nothing", () => {
		expect(addressOf({ action: "reply" }, 2)).toBe("3");
	});
});

describe("labelling each tab by what kind of thing it is", () => {
	// One vocabulary across the strip, and every mark one the review
	// family already owns. The running number beside it belongs to the
	// batch, so five replies read 1 to 5 rather than restarting per kind.
	it("marks a reply as a reply", () => {
		expect(glyphOf({ action: "reply", thread: 1, body: "x" })).toBe("\u21b3");
	});

	it("marks a new thread as a thread", () => {
		expect(glyphOf({ action: "annotate", path: "a.go", line: 1 })).toBe(
			"\u276f",
		);
	});

	it("marks a top-level comment as a document", () => {
		expect(glyphOf({ action: "comment", body: "x" })).toBe("\u00b6");
	});

	it("marks a reaction as a reaction", () => {
		expect(glyphOf({ action: "react", comment: "C1", reaction: "eyes" })).toBe(
			"\u2726",
		);
	});

	it("marks settling by the box it leaves the thread in", () => {
		expect(glyphOf({ action: "resolve", thread: 1 })).toBe("\u2611");
		expect(glyphOf({ action: "unresolve", thread: 1 })).toBe("\u2610");
	});

	it("gives two replies the same mark, which is the point", () => {
		// They are told apart by position, not by name. That is why a
		// decision comes back as an index.
		const one = glyphOf({ action: "reply", thread: 1, body: "a" });
		const two = glyphOf({ action: "reply", thread: 9, body: "b" });
		expect(one).toBe(two);
	});
});

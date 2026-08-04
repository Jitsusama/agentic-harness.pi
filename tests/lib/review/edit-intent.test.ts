/**
 * Editing a change is not retargeting it.
 *
 * The tool mapped every `edit` action to the `retarget` intent, so
 * changing a title asked the provider whether it could move a base. On
 * GitHub that is yes and nobody noticed. On a backend where a base is a
 * property of the stack rather than of the change, the answer is a
 * refusal that explains stack semantics, which is true and has nothing
 * to do with a title.
 *
 * These tests are on the pure gate rather than the tool, since the tool
 * chooses the intent and the gate decides what each one costs. What the
 * tool chooses is pinned in the findability suite by its parameters.
 */

import { describe, expect, it } from "vitest";
import {
	type AuthoringCapabilities,
	offerable,
} from "../../../lib/review/index.js";

/** A backend where a base belongs to the stack, not the change. */
const STACKED: AuthoringCapabilities = {
	propose: true,
	proposeStack: true,
	reviewersAt: "creation",
	retarget: "stack",
	setDraft: false,
	close: true,
	reopen: false,
	merge: true,
	labels: true,
	assignees: true,
	identifies: "email",
	refusesWhileEnqueued: true,
	rerunChecks: false,
};

describe("the edit intent", () => {
	it("is permitted where retargeting is not", () => {
		// The bug, stated as a test: these two must not answer alike.
		expect(offerable({ kind: "edit" }, STACKED, "meteorite").ok).toBe(true);
		expect(offerable({ kind: "retarget" }, STACKED, "meteorite").ok).toBe(
			false,
		);
	});

	it("is still refused while the change is holding a place in a queue", () => {
		// Editing is cheap, but not while a queue has speculatively batched
		// the change: the ejection costs the same whatever was edited.
		const answer = offerable(
			{ kind: "edit", queue: { posture: "queued", solo: false } },
			STACKED,
			"meteorite",
		);

		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.reason).toContain("batched with it");
	});

	it("is permitted while queued where the backend does not eject", () => {
		expect(
			offerable(
				{ kind: "edit", queue: { posture: "queued" } },
				{ ...STACKED, refusesWhileEnqueued: false },
				"github",
			).ok,
		).toBe(true);
	});

	it("warns rather than refusing when the queue could not be read", () => {
		// The case that made this arm exist. Merge Garden holds the queue for
		// the World monolith, and the change's own API does not carry it, so a
		// provider can have a queue and be unable to see it. Refusing would
		// make that backend read-only; permitting silently hands somebody an
		// ejection with no warning.
		const answer = offerable({ kind: "edit" }, STACKED, "meteorite");

		expect(answer.ok).toBe(true);
		expect(answer.ok && answer.caution).toContain("merge queue");
	});

	it("stays quiet when the backend has no queue to be unsure about", () => {
		const answer = offerable(
			{ kind: "edit" },
			{ ...STACKED, refusesWhileEnqueued: false },
			"github",
		);

		expect(answer.ok && answer.caution).toBeUndefined();
	});

	it("stays quiet once the queue has actually answered", () => {
		const answer = offerable(
			{ kind: "edit", queue: { posture: "unqueued" } },
			STACKED,
			"meteorite",
		);

		expect(answer.ok && answer.caution).toBeUndefined();
	});

	it("does not let an unknown queue talk over a refusal", () => {
		// The regression this arm caused on its first attempt: returning the
		// caution directly skipped every per-intent question, so a backend
		// that had just said it cannot retarget was permitted to.
		const answer = offerable({ kind: "retarget" }, STACKED, "meteorite");

		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.reason).toMatch(/stack/i);
	});

	it("does not let an unknown queue talk over a draft refusal either", () => {
		expect(offerable({ kind: "set-draft" }, STACKED, "meteorite").ok).toBe(
			false,
		);
	});

	it("says nothing about stacks when refusing an edit", () => {
		// A refusal that explains the wrong mechanism is worse than none:
		// it sends the reader to fix something that was never the problem.
		const answer = offerable(
			{ kind: "edit", queue: { posture: "queued" } },
			STACKED,
			"meteorite",
		);

		expect(!answer.ok && answer.reason).not.toMatch(/stack/i);
	});
});

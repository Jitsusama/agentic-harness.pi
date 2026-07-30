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
	autoMerge: false,
	deleteBranchOnMerge: false,
	refusesWhileEnqueued: true,
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

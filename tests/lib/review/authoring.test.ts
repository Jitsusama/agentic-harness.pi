import { describe, expect, it } from "vitest";
import type { AuthoringCapabilities } from "../../../lib/review/index.js";
import { offerable } from "../../../lib/review/index.js";

/** What GitHub answered when the survey asked it. */
const github: AuthoringCapabilities = {
	propose: true,
	proposeStack: false,
	reviewersAt: "any-time",
	retarget: "change",
	setDraft: true,
	close: true,
	reopen: true,
	merge: true,
	labels: true,
	assignees: true,
	refusesWhileEnqueued: false,
};

/** What Meteorite answered. Every difference here was measured. */
const meteorite: AuthoringCapabilities = {
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
	refusesWhileEnqueued: true,
};

describe("what a provider will accept", () => {
	it("allows what the provider does", () => {
		expect(offerable({ kind: "propose" }, github, "github")).toEqual({
			ok: true,
		});
	});

	it("refuses what it does not, naming the provider", () => {
		// Never a generic failure: which backend was asked is the first
		// thing somebody needs to know.
		const answer = offerable({ kind: "reopen" }, meteorite, "meteorite");

		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.reason).toContain("meteorite");
	});

	it("refuses when there is no authoring facet at all", () => {
		const answer = offerable({ kind: "propose" }, undefined, "git");

		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.reason).toContain("git");
	});
});

describe("retargeting, which is not the same operation everywhere", () => {
	it("allows a change retarget where the backend retargets changes", () => {
		expect(offerable({ kind: "retarget" }, github, "github").ok).toBe(true);
	});

	it("refuses a change retarget where retargeting is a stack operation", () => {
		// The measured difference: on Meteorite a base change goes
		// through submitting the whole stack, so retargeting one change
		// is not a smaller version of the same thing.
		const answer = offerable({ kind: "retarget" }, meteorite, "meteorite");

		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.instead).toMatch(/stack/i);
	});
});

describe("reviewers, which one backend only takes at creation", () => {
	it("allows requesting reviewers later where the backend does", () => {
		expect(offerable({ kind: "request-reviewers" }, github, "github").ok).toBe(
			true,
		);
	});

	it("refuses requesting reviewers later where they are creation-only", () => {
		const answer = offerable(
			{ kind: "request-reviewers" },
			meteorite,
			"meteorite",
		);

		expect(answer.ok).toBe(false);
		// The refusal has to name the door that is open, whichever word it
		// uses for the moment: this is the difference between a caller
		// giving up and a caller moving the reviewers to the propose call.
		expect(!answer.ok && answer.instead).toMatch(/propos|creat/i);
	});

	it("allows naming reviewers on the proposal itself", () => {
		// Creation-only means creation works. A caller told "not
		// supported" would never learn the one moment it is.
		expect(
			offerable(
				{ kind: "propose", withReviewers: true },
				meteorite,
				"meteorite",
			).ok,
		).toBe(true);
	});

	it("refuses naming reviewers on a proposal where reviewers are never a thing", () => {
		const answer = offerable(
			{ kind: "propose", withReviewers: true },
			{ ...github, reviewersAt: "never" },
			"forge",
		);

		expect(answer.ok).toBe(false);
	});
});

describe("mutating a change that is queued to merge", () => {
	it("refuses a mutation while enqueued where that ejects the stack", () => {
		// The expensive one. On a merge-queue backend a push, a rebase or
		// a base change ejects the PR and everything batched with it, and
		// re-running CI for the rest reaches into the hundreds.
		const answer = offerable(
			{ kind: "retarget", queue: { posture: "queued", solo: false } },
			{ ...meteorite, retarget: "change" },
			"meteorite",
		);

		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.reason).toMatch(/queue|enqueued/i);
	});

	it("allows the same mutation once it is not enqueued", () => {
		expect(
			offerable(
				{ kind: "retarget", queue: { posture: "unqueued" } },
				{ ...meteorite, retarget: "change" },
				"meteorite",
			).ok,
		).toBe(true);
	});

	it("allows the mutation when no queue state was reported at all", () => {
		// Absent is unknown, not queued. Refusing on silence would break
		// every provider that has no queue.
		expect(
			offerable(
				{ kind: "retarget" },
				{ ...meteorite, retarget: "change" },
				"meteorite",
			).ok,
		).toBe(true);
	});

	it("allows a mutation while enqueued where the backend does not care", () => {
		expect(
			offerable(
				{ kind: "retarget", queue: { posture: "queued" } },
				github,
				"github",
			).ok,
		).toBe(true);
	});

	it("still allows reading-shaped intents while enqueued", () => {
		// Merging is what the queue is for, so it is not a mutation the
		// queue objects to.
		expect(
			offerable(
				{ kind: "merge", queue: { posture: "queued" } },
				meteorite,
				"meteorite",
			).ok,
		).toBe(true);
	});

	it("refuses a mutation while waiting on checks, for a different reason", () => {
		// Not ejection: the checks ran once when it was marked ready, and a
		// new commit does not retrigger them.
		const answer = offerable(
			{ kind: "retarget", queue: { posture: "waiting" } },
			{ ...meteorite, retarget: "change" },
			"meteorite",
		);

		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.reason).toMatch(/waiting/i);
	});
});

describe("the draft flag, which defaults opposite ways", () => {
	it("refuses flipping draft where the backend cannot", () => {
		const answer = offerable({ kind: "set-draft" }, meteorite, "meteorite");

		expect(answer.ok).toBe(false);
	});

	it("allows flipping draft where it can", () => {
		expect(offerable({ kind: "set-draft" }, github, "github").ok).toBe(true);
	});
});

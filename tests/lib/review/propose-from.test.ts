import { describe, expect, it } from "vitest";
import type { CheckoutFacts } from "../../../lib/review/index.js";
import { fillProposal } from "../../../lib/review/index.js";

const facts = (over: Partial<CheckoutFacts> = {}): CheckoutFacts => ({
	branch: "topic",
	trunk: "main",
	subject: "Close the handle on the error path",
	...over,
});

describe("filling in what git already knows", () => {
	it("takes the head from the branch you are standing on", () => {
		const answer = fillProposal({}, facts());

		expect("fill" in answer && answer.fill.head).toBe("topic");
	});

	it("takes the base from the trunk", () => {
		const answer = fillProposal({}, facts());

		expect("fill" in answer && answer.fill.base).toBe("main");
	});

	it("takes the title from the last commit's subject", () => {
		const answer = fillProposal({}, facts());

		expect("fill" in answer && answer.fill.title).toBe(
			"Close the handle on the error path",
		);
	});

	it("says everything it guessed", () => {
		// The whole bargain: inferring is fine as long as the gate can
		// show what was inferred. A guess nobody sees is the thing worth
		// avoiding, not a guess.
		const answer = fillProposal({}, facts());

		expect("fill" in answer && answer.fill.guessed.sort()).toEqual([
			"base",
			"head",
			"title",
		]);
	});
});

describe("what you said wins", () => {
	it("keeps a title you gave", () => {
		const answer = fillProposal({ title: "Mine" }, facts());

		expect("fill" in answer && answer.fill.title).toBe("Mine");
	});

	it("does not call a field you gave a guess", () => {
		const answer = fillProposal({ title: "Mine", base: "release" }, facts());

		expect("fill" in answer && answer.fill.guessed).toEqual(["head"]);
	});

	it("keeps a base you gave over the trunk", () => {
		const answer = fillProposal({ base: "release" }, facts());

		expect("fill" in answer && answer.fill.base).toBe("release");
	});
});

describe("when it cannot work something out", () => {
	it("refuses with no branch and none given", () => {
		const answer = fillProposal({}, facts({ branch: undefined }));

		expect("refusal" in answer && answer.refusal).toMatch(/branch/i);
	});

	it("is content with no branch when you named the head", () => {
		const answer = fillProposal(
			{ head: "other" },
			facts({ branch: undefined }),
		);

		expect("fill" in answer && answer.fill.head).toBe("other");
	});

	it("refuses with no trunk and no base given", () => {
		// Guessing a base wrong proposes a change against something
		// nobody meant, and on a busy repo that pings the wrong people.
		const answer = fillProposal({}, facts({ trunk: undefined }));

		expect("refusal" in answer && answer.refusal).toMatch(/base|target/i);
	});

	it("refuses with no title and nothing to take one from", () => {
		const answer = fillProposal({}, facts({ subject: undefined }));

		expect("refusal" in answer && answer.refusal).toMatch(/title/i);
	});

	it("refuses to propose a branch onto itself", () => {
		// A change from main to main is not a change, and the backend's
		// error for it is worse than this one.
		const answer = fillProposal({}, facts({ branch: "main" }));

		expect("refusal" in answer && answer.refusal).toMatch(/itself|same/i);
	});
});

describe("the body", () => {
	it("is empty when nothing offers one", () => {
		const answer = fillProposal({}, facts());

		expect("fill" in answer && answer.fill.body).toBe("");
	});

	it("takes what the commits said when they said something", () => {
		const answer = fillProposal(
			{},
			facts({ bodyFromCommits: "because the handle leaked" }),
		);

		expect("fill" in answer && answer.fill.body).toBe(
			"because the handle leaked",
		);
		expect("fill" in answer && answer.fill.guessed).toContain("body");
	});

	it("keeps a body you wrote", () => {
		const answer = fillProposal(
			{ body: "mine" },
			facts({ bodyFromCommits: "theirs" }),
		);

		expect("fill" in answer && answer.fill.body).toBe("mine");
	});
});

describe("uncommitted work", () => {
	it("warns rather than refusing", () => {
		// Not a refusal: proposing with a dirty tree is legitimate, since
		// what gets proposed is what was pushed. But somebody who forgot
		// to commit wants to know before the change goes up, not after a
		// reviewer reads a diff missing the last thing they wrote.
		const answer = fillProposal({}, facts({ dirty: true }));

		expect("fill" in answer).toBe(true);
		expect("fill" in answer && answer.fill.warnings.join(" ")).toMatch(
			/uncommitted|not been committed/i,
		);
	});

	it("says nothing about a clean tree", () => {
		const answer = fillProposal({}, facts());

		expect("fill" in answer && answer.fill.warnings).toEqual([]);
	});
});

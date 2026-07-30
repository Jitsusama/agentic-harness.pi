import { describe, expect, it } from "vitest";
import { treeRequestFrom } from "../../../lib/work/index.js";

const repo = { key: "github:Shopify/world", localPath: "/checkout" };

/** Narrow an outcome to its request, failing loudly when refused. */
function granted(outcome: ReturnType<typeof treeRequestFrom>) {
	if ("refusal" in outcome) {
		throw new Error(`expected a request, got refusal: ${outcome.refusal}`);
	}
	return outcome.request;
}

/** Narrow an outcome to its refusal sentence. */
function refused(outcome: ReturnType<typeof treeRequestFrom>): string {
	if (!("refusal" in outcome)) {
		throw new Error("expected a refusal, got a request");
	}
	return outcome.refusal;
}

describe("treeRequestFrom", () => {
	it("builds a worktree request from a branch", () => {
		const request = granted(
			treeRequestFrom({
				intent: "worktree",
				repo,
				purpose: "fix",
				branch: "topic",
			}),
		);
		expect(request).toEqual({
			intent: "worktree",
			repo,
			purpose: "fix",
			branch: "topic",
		});
	});

	it("builds a snapshot request from a commit", () => {
		const request = granted(
			treeRequestFrom({
				intent: "snapshot",
				repo,
				purpose: "review",
				commit: "abc123",
			}),
		);
		expect(request).toEqual({
			intent: "snapshot",
			repo,
			purpose: "review",
			commit: "abc123",
		});
	});

	it("carries paths onto a snapshot when asked for a sparse one", () => {
		const request = granted(
			treeRequestFrom({
				intent: "snapshot",
				repo,
				purpose: "review",
				commit: "abc123",
				paths: ["areas/tools"],
			}),
		);
		expect(request).toMatchObject({ paths: ["areas/tools"] });
	});

	// The two intents need different inputs, and the refusal has to
	// say which one is missing rather than that something is. A
	// caller who sent a commit to a worktree has made a specific
	// mistake and can be told exactly that.
	it("refuses a worktree with no branch, naming the branch", () => {
		const refusal = refused(
			treeRequestFrom({ intent: "worktree", repo, purpose: "fix" }),
		);
		expect(refusal).toMatch(/branch/);
	});

	it("refuses a snapshot with no commit, naming the commit", () => {
		const refusal = refused(
			treeRequestFrom({ intent: "snapshot", repo, purpose: "review" }),
		);
		expect(refusal).toMatch(/commit/);
	});

	it("refuses a purpose that is blank, since it names the tree", () => {
		const refusal = refused(
			treeRequestFrom({
				intent: "worktree",
				repo,
				purpose: "   ",
				branch: "topic",
			}),
		);
		expect(refusal).toMatch(/purpose/);
	});

	// A repo with neither a checkout nor a remote cannot be cut
	// from at all, and the provider would otherwise be asked to
	// work it out and fail further from the cause.
	it("refuses a repo that is neither on disk nor remote", () => {
		const refusal = refused(
			treeRequestFrom({
				intent: "worktree",
				repo: { key: "github:Shopify/world" },
				purpose: "fix",
				branch: "topic",
			}),
		);
		expect(refusal).toMatch(/checkout|remote/);
	});

	// Sending a commit to a worktree is a different error from
	// omitting the branch, and saying so is what stops somebody
	// re-sending the same wrong field.
	it("refuses a worktree given a commit instead of a branch", () => {
		const refusal = refused(
			treeRequestFrom({
				intent: "worktree",
				repo,
				purpose: "fix",
				commit: "abc123",
			}),
		);
		expect(refusal).toMatch(/commit/);
		expect(refusal).toMatch(/branch/);
	});
});

import { describe, expect, it } from "vitest";
import { createGitProvider } from "../../../lib/review";
import { callMatching, fakeExec, type Reply } from "./support/fake-exec.js";

function provider(replies: Reply[]) {
	const { exec, calls } = fakeExec(replies);
	return { git: createGitProvider({ exec }), calls };
}

const repo = { key: "local:/src/app", localPath: "/src/app" };

describe("the git provider's identity", () => {
	it("claims last, so any forge gets the repo first", () => {
		const { git } = provider([]);
		expect(git.id).toBe("git");
		expect(git.priority).toBeGreaterThan(100);
	});

	it("claims any checkout it is given a path to", () => {
		const { git } = provider([]);
		expect(git.claimRepo({ repoRoot: "/src/app" })).toEqual({
			key: "local:/src/app",
			localPath: "/src/app",
		});
	});

	it("claims nothing without a checkout to stand in", () => {
		const { git } = provider([]);
		expect(
			git.claimRepo({ remoteUrls: ["git@github.com:Shopify/world.git"] }),
		).toBeNull();
	});

	it("recognizes a branch or a range as a reference", () => {
		const { git } = provider([]);
		expect(git.claimReference("refs/heads/topic", repo)?.id).toBe(
			"refs/heads/topic",
		);
		expect(git.claimReference("main..topic", repo)?.id).toBe("main..topic");
	});

	it("claims no reference without a repo to read it against", () => {
		const { git } = provider([]);
		expect(git.claimReference("topic")).toBeNull();
	});
});

describe("what a bare repo can honestly do", () => {
	it("has no conversation anywhere", () => {
		const { git } = provider([]);
		expect(git.capabilities(repo).conversation).toBeUndefined();
		expect(git.conversation).toBeUndefined();
	});

	it("reads a stack, and says the shape was derived", () => {
		const { git } = provider([]);
		expect(git.capabilities(repo).stacking?.provenance).toBe("derived");
	});

	it("hosts no proposals, so it cannot list or check them", () => {
		const { git } = provider([]);
		expect(git.capabilities(repo).proposals).toBeUndefined();
	});
});

describe("reading a stack from a checkout", () => {
	/** `git config --get branch.<name>.merge` answers. */
	function upstreamOf(branch: string, parent: string | null): Reply {
		return parent
			? { when: [`branch.${branch}.merge`], stdout: `refs/heads/${parent}\n` }
			: { when: [`branch.${branch}.merge`], code: 1 };
	}

	it("walks upstream links to the trunk", async () => {
		const { git } = provider([
			upstreamOf("top", "middle"),
			upstreamOf("middle", "bottom"),
			upstreamOf("bottom", "main"),
			upstreamOf("main", null),
			{ when: ["for-each-ref"], stdout: "" },
			{ when: ["merge-base"], stdout: "abc123\n" },
			{ when: ["rev-parse"], stdout: "def456\n" },
		]);
		const stack = await git.stacking?.stack({ repo, ref: "top" });
		expect(stack?.nodes.map((node) => node.ref)).toEqual([
			"bottom",
			"middle",
			"top",
		]);
		expect(stack?.trunk).toBe("main");
		expect(stack?.cursor).toBe(2);
		expect(stack?.provenance).toBe("derived");
	});

	it("records each node's fork point from its parent", async () => {
		const { git, calls } = provider([
			upstreamOf("topic", "main"),
			upstreamOf("main", null),
			{ when: ["for-each-ref"], stdout: "" },
			{ when: ["merge-base"], stdout: "forkpoint1\n" },
			{ when: ["rev-parse"], stdout: "head1\n" },
		]);
		const stack = await git.stacking?.stack({ repo, ref: "topic" });
		const topic = stack?.nodes.find((node) => node.ref === "topic");
		expect(topic?.forkPoint).toBe("forkpoint1");
		expect(topic?.headCommit).toBe("head1");
		expect(callMatching(calls, "merge-base")?.args).toContain("/src/app");
	});

	it("says a node is behind when its parent has moved since it forked", async () => {
		// The one warning the stack view carries, and it was declared by the
		// contract and set by no provider, so a stack needing a restack drew
		// exactly like a current one.
		const { git } = provider([
			upstreamOf("topic", "main"),
			upstreamOf("main", null),
			{ when: ["for-each-ref"], stdout: "" },
			{ when: ["merge-base"], stdout: "forkedhere\n" },
			{ when: ["rev-parse", "main"], stdout: "mainmovedon\n" },
			{ when: ["rev-parse", "topic"], stdout: "topichead\n" },
		]);

		const stack = await git.stacking?.stack({ repo, ref: "topic" });

		expect(
			stack?.nodes.find((node) => node.ref === "topic")?.behindParent,
		).toBe(true);
	});

	it("says a node is not behind when it forked from where its parent still is", async () => {
		const { git } = provider([
			upstreamOf("topic", "main"),
			upstreamOf("main", null),
			{ when: ["for-each-ref"], stdout: "" },
			{ when: ["merge-base"], stdout: "sameplace\n" },
			{ when: ["rev-parse", "main"], stdout: "sameplace\n" },
			{ when: ["rev-parse", "topic"], stdout: "topichead\n" },
		]);

		const stack = await git.stacking?.stack({ repo, ref: "topic" });

		expect(
			stack?.nodes.find((node) => node.ref === "topic")?.behindParent,
		).toBe(false);
	});

	it("leaves it unsaid when there is nothing to measure against", async () => {
		// Absent rather than false. The field means "where the provider can
		// tell", and a root with no trunk named cannot, so drawing it as
		// current would be the same lie the drift report used to tell.
		const { git } = provider([
			upstreamOf("lonely", null),
			{ when: ["for-each-ref"], stdout: "" },
			{ when: ["rev-parse"], stdout: "head1\n" },
		]);

		const stack = await git.stacking?.stack({ repo, ref: "lonely" });

		expect(stack?.nodes[0]?.behindParent).toBeUndefined();
	});

	it("reports a lone branch with no upstream as its own stack", async () => {
		const { git } = provider([
			upstreamOf("orphan", null),
			{ when: ["for-each-ref"], stdout: "" },
			{ when: ["rev-parse"], stdout: "head1\n" },
		]);
		const stack = await git.stacking?.stack({ repo, ref: "orphan" });
		expect(stack?.nodes.map((node) => node.ref)).toEqual(["orphan"]);
		expect(stack?.nodes[0].parent).toBeUndefined();
		expect(stack?.trunk).toBeUndefined();
	});

	it("finds the branches stacked on top of the cursor", async () => {
		const { git } = provider([
			upstreamOf("middle", "main"),
			upstreamOf("main", null),
			// Every branch and the upstream it records.
			{
				when: ["for-each-ref"],
				stdout: [
					"main|",
					"middle|refs/heads/main",
					"upper|refs/heads/middle",
					"unrelated|refs/heads/other",
				].join("\n"),
			},
			{ when: ["merge-base"], stdout: "fork\n" },
			{ when: ["rev-parse"], stdout: "head\n" },
		]);
		const stack = await git.stacking?.stack({ repo, ref: "middle" });
		expect(stack?.nodes.map((node) => node.ref)).toEqual(["middle", "upper"]);
		expect(stack?.nodes[1].parent).toBe("middle");
	});

	it("keeps both branches when the stack fans out", async () => {
		const { git } = provider([
			upstreamOf("base", null),
			{
				when: ["for-each-ref"],
				stdout: ["base|", "left|refs/heads/base", "right|refs/heads/base"].join(
					"\n",
				),
			},
			{ when: ["rev-parse"], stdout: "head\n" },
			{ when: ["merge-base"], stdout: "fork\n" },
		]);
		const stack = await git.stacking?.stack({ repo, ref: "base" });
		expect(stack?.nodes.map((node) => node.ref)).toEqual([
			"base",
			"left",
			"right",
		]);
	});

	it("strips the refs/heads prefix a caller may pass", async () => {
		const { git } = provider([
			upstreamOf("topic", null),
			{ when: ["for-each-ref"], stdout: "" },
			{ when: ["rev-parse"], stdout: "head\n" },
		]);
		const stack = await git.stacking?.stack({
			repo,
			ref: "refs/heads/topic",
		});
		expect(stack?.nodes[0].ref).toBe("topic");
	});
});

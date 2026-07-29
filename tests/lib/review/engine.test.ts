import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearReviewProviders,
	clearTargetBindings,
	createDraftStore,
	createGitHubProvider,
	createGitProvider,
	createReviewEngine,
	type ReviewEngine,
	registerReviewProvider,
} from "../../../lib/review";
import { fakeExec, type Reply } from "./support/fake-exec.js";

const pullJson = JSON.stringify({
	number: 123,
	title: "A change",
	body: "",
	state: "open",
	draft: false,
	merged_at: null,
	user: { login: "someone" },
	base: { ref: "main" },
	head: { ref: "topic", sha: "abc" },
	html_url: "https://github.com/Shopify/world/pull/123",
});

/** What a checkout of the GitHub mirror answers. */
const inCheckout: Reply[] = [
	{ when: ["--show-toplevel"], stdout: "/src/world\n" },
	{
		when: ["remote.origin.url"],
		stdout: "git@github.com:Shopify/world.git\n",
	},
	{
		when: ["--get-regexp"],
		stdout: "remote.origin.url git@github.com:Shopify/world.git\n",
	},
];

let root: string;

function engineWith(replies: Reply[]): {
	engine: ReviewEngine;
	calls: ReturnType<typeof fakeExec>["calls"];
} {
	const { exec, calls } = fakeExec(replies);
	registerReviewProvider(createGitHubProvider({ exec }));
	registerReviewProvider(createGitProvider({ exec }));
	const engine = createReviewEngine({
		exec,
		store: createDraftStore(root),
	});
	return { engine, calls };
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "review-engine-"));
});

afterEach(async () => {
	clearReviewProviders();
	clearTargetBindings();
	await rm(root, { recursive: true, force: true });
});

describe("probing a checkout", () => {
	it("reads the repo root and its remotes", async () => {
		const { engine } = engineWith(inCheckout);
		const probe = await engine.probe("/src/world/sub/dir");
		expect(probe.repoRoot).toBe("/src/world");
		expect(probe.remoteUrls).toContain("git@github.com:Shopify/world.git");
	});

	it("reports nothing when the directory is not a repo", async () => {
		const { engine } = engineWith([
			{ when: ["--show-toplevel"], code: 128, stderr: "not a git repo" },
		]);
		const probe = await engine.probe("/tmp/elsewhere");
		expect(probe.repoRoot).toBeUndefined();
	});
});

describe("resolving a reference", () => {
	it("binds a pull request URL to the GitHub provider", async () => {
		const { engine } = engineWith([{ when: ["pulls/123"], stdout: pullJson }]);
		const bound = await engine.resolve(
			"https://github.com/Shopify/world/pull/123",
		);
		expect(bound.provider.id).toBe("github");
		expect(bound.target.kind).toBe("proposal");
		expect(bound.capabilities.conversation?.anchoredBatchReview).toBe(true);
	});

	it("reads a bare number against the checkout it was asked from", async () => {
		const { engine } = engineWith([
			...inCheckout,
			{ when: ["pulls/123"], stdout: pullJson },
		]);
		const bound = await engine.resolve("123", "/src/world");
		expect(bound.provider.id).toBe("github");
		expect(bound.target.kind === "proposal" && bound.target.change.id).toBe(
			"123",
		);
	});

	it("refuses with the guidance the resolver produced", async () => {
		const { engine } = engineWith([
			{ when: ["--show-toplevel"], code: 128, stderr: "nope" },
		]);
		await expect(engine.resolve("what is this")).rejects.toThrow(
			/review\.references/,
		);
	});
});

describe("a bound hosted change", () => {
	it("reads its proposal and its diff through the provider", async () => {
		const diff = "diff --git a/x.ts b/x.ts\n";
		const { engine } = engineWith([
			{ when: ["pulls/123"], stdout: pullJson },
			{ when: ["pr", "diff"], stdout: diff },
		]);
		const bound = await engine.resolve(
			"https://github.com/Shopify/world/pull/123",
		);
		expect((await bound.proposal())?.title).toBe("A change");
		expect(await bound.diff()).toBe(diff);
	});

	it("parses its diff on request", async () => {
		const diff = `diff --git a/x.ts b/x.ts
index 1111111..2222222 100644
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-before
+after
`;
		const { engine } = engineWith([
			{ when: ["pulls/123"], stdout: pullJson },
			{ when: ["pr", "diff"], stdout: diff },
		]);
		const bound = await engine.resolve(
			"https://github.com/Shopify/world/pull/123",
		);
		const model = await bound.diffModel();
		expect(model.files[0].newPath).toBe("x.ts");
	});

	it("offers the provider's conversation", async () => {
		const { engine } = engineWith([{ when: ["pulls/123"], stdout: pullJson }]);
		const bound = await engine.resolve(
			"https://github.com/Shopify/world/pull/123",
		);
		expect(bound.conversation).toBeTruthy();
	});
});

describe("a target with no host", () => {
	const localRepo: Reply[] = [
		{ when: ["--show-toplevel"], stdout: "/src/app\n" },
		{ when: ["--get-regexp"], stdout: "" },
	];

	it("reviews a range of commits in a plain checkout", async () => {
		const { engine } = engineWith([
			...localRepo,
			{ when: ["diff", "main...topic"], stdout: "diff --git a/y b/y\n" },
		]);
		const bound = await engine.fromLocal("/src/app", {
			base: "main",
			head: "topic",
		});
		expect(bound.provider.id).toBe("git");
		expect(bound.target.kind).toBe("range");
		expect(await bound.diff()).toContain("diff --git");
	});

	it("has no conversation to offer", async () => {
		const { engine } = engineWith(localRepo);
		const bound = await engine.fromLocal("/src/app", {
			base: "main",
			head: "topic",
		});
		expect(bound.conversation).toBeNull();
	});

	it("reviews a stack of refs as one body of work", async () => {
		const { engine } = engineWith([
			...localRepo,
			{ when: ["diff", "one...two"], stdout: "diff --git a/z b/z\n" },
		]);
		const bound = await engine.fromLocal("/src/app", {
			refs: ["one", "two"],
		});
		expect(bound.target.kind).toBe("stack");
		expect(await bound.diff()).toContain("diff --git");
	});

	it("reads the stack its provider can derive", async () => {
		const { engine } = engineWith([
			...localRepo,
			{ when: ["branch.topic.merge"], stdout: "refs/heads/main\n" },
			{ when: ["branch.main.merge"], code: 1 },
			{ when: ["for-each-ref"], stdout: "" },
			{ when: ["rev-parse", "topic"], stdout: "head\n" },
			{ when: ["merge-base"], stdout: "fork\n" },
		]);
		const bound = await engine.fromLocal("/src/app", { refs: ["topic"] });
		const stack = await bound.stack();
		expect(stack?.provenance).toBe("derived");
		expect(stack?.nodes[0].ref).toBe("topic");
	});
});

describe("opening a draft on a bound target", () => {
	it("hands back a draft about that target", async () => {
		const { engine } = engineWith([{ when: ["pulls/123"], stdout: pullJson }]);
		const bound = await engine.resolve(
			"https://github.com/Shopify/world/pull/123",
		);
		const draft = await engine.openDraft(bound.target);
		expect(draft.state.target).toEqual(bound.target);
	});

	it("plans against the bound provider's capabilities without being told", async () => {
		const { engine } = engineWith([{ when: ["pulls/123"], stdout: pullJson }]);
		const bound = await engine.resolve(
			"https://github.com/Shopify/world/pull/123",
		);
		const draft = await engine.openDraft(bound.target);
		await draft.addFinding({
			anchor: { subject: "file", path: "x.ts" },
			body: "note",
		});
		const plan = draft.plan({ capabilities: bound.capabilities });
		expect(plan.ops).toHaveLength(1);
	});
});

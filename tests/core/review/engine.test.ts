import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../../../lib/core/exec/index.ts";
import {
	clearReviewProviders,
	clearTargetBindings,
	createDraftStore,
	createGitHubProvider,
	createGitProvider,
	createReviewEngine,
	type ReviewEngine,
	registerReviewProvider,
} from "../../../lib/core/review/index.ts";
import { GIT_REFUSED } from "../../../lib/internal/sandbox/tree-git.ts";
import { fakeExec, type Reply } from "../../support/fake-exec.ts";
import { stubProvider } from "../../support/stub-provider.ts";

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
		expect(probe.origin).toBe("git@github.com:Shopify/world.git");
	});

	it("reports nothing when the directory is not a repo", async () => {
		const { engine } = engineWith([
			{
				when: ["--show-toplevel"],
				code: 128,
				stderr:
					"fatal: not a git repository (or any of the parent directories): .git\n",
			},
		]);
		const probe = await engine.probe("/tmp/elsewhere");
		expect(probe.repoRoot).toBeUndefined();
	});

	it("refuses a worktree whose git folder was pruned, not taking it as no repo", async () => {
		const { engine } = engineWith([
			{
				when: ["--show-toplevel"],
				code: 128,
				stderr:
					"fatal: not a git repository: /src/world/.git/worktrees/topic\n",
			},
		]);
		await expect(
			engine.probe("/src/topic"),
			"a broken worktree is refused, naming what git said",
		).rejects.toThrow(/could not say whether \/src\/topic is a checkout/);
	});

	it("refuses a checkout whose remotes went unread, rather than answering none", async () => {
		const { engine } = engineWith([
			{ when: ["--show-toplevel"], stdout: "/src/world\n" },
			{
				when: ["--get-regexp"],
				code: 137,
				stderr: "git was killed by SIGKILL.",
			},
		]);
		await expect(
			engine.probe("/src/world"),
			"a probe never passes an unread checkout off as one with no remotes",
		).rejects.toThrow(/could not read the remotes of \/src\/world/);
	});
});

describe("a checkout whose remotes git could not read", () => {
	/** What spawnExec answers for a git that could not start under load. */
	const couldNotStart: ExecResult = {
		code: 1,
		stdout: "",
		stderr: "spawn git EAGAIN",
	};

	/**
	 * An exec whose reads matching `fragment` fail as `failure` the first
	 * `failing` times, counting each one asked.
	 */
	function failing(
		fragment: string,
		failure: ExecResult,
		times: number,
	): { exec: Exec; asked: () => number } {
		const { exec } = fakeExec([
			...inCheckout,
			{ when: ["pulls/123"], stdout: pullJson },
		]);
		let asked = 0;
		return {
			asked: () => asked,
			exec: async (command, args) => {
				if (!args.includes(fragment)) return exec(command, args);
				asked += 1;
				return asked <= times ? failure : exec(command, args);
			},
		};
	}

	function engineOver(exec: Exec): ReviewEngine {
		registerReviewProvider(createGitHubProvider({ exec }));
		registerReviewProvider(createGitProvider({ exec }));
		return createReviewEngine({ exec, store: createDraftStore(root) });
	}

	const range = { base: "main", head: "topic" };

	it("asks once more, and binds a hosted range to its host", async () => {
		const engine = engineOver(failing("--get-regexp", couldNotStart, 1).exec);
		const bound = await engine.fromLocal("/src/world", range);
		expect(
			bound.repo.key,
			"a git that could not start is asked again, not taken as no remotes",
		).toBe("github:Shopify/world");
	});

	it("refuses rather than keying a hosted range by its path", async () => {
		const engine = engineOver(failing("--get-regexp", couldNotStart, 2).exec);
		await expect(
			engine.fromLocal("/src/world", range),
			"a range whose remotes stay unread is refused, naming both attempts",
		).rejects.toThrow(
			/could not read the remotes of \/src\/world: spawn git EAGAIN \(exit 1\), then asked again, spawn git EAGAIN \(exit 1\)\. Asking again usually gets through/,
		);
	});

	it("refuses a read the clock stopped without asking again", async () => {
		const remotes = failing(
			"--get-regexp",
			{ code: 124, stdout: "", stderr: "timed out" },
			1,
		);
		await expect(
			engineOver(remotes.exec).fromLocal("/src/world", range),
			"a read that already had its ten minutes is refused at once",
		).rejects.toThrow(
			/timed out \(exit 124\)\. git ran its whole time without answering; ask again once whatever held it/,
		);
		expect(remotes.asked(), "a stopped read is asked only once").toBe(1);
	});

	it("refuses what the fence refused without asking again", async () => {
		const remotes = failing(
			"--get-regexp",
			{
				code: GIT_REFUSED,
				stdout: "",
				stderr: "git refused: outside the stage",
			},
			1,
		);
		await expect(
			engineOver(remotes.exec).fromLocal("/src/world", range),
			"the fence's refusal is said as one that will repeat",
		).rejects.toThrow(/git refused: outside the stage.*will fail the same way/);
		expect(remotes.asked(), "a refusal by the fence is asked only once").toBe(
			1,
		);
	});

	it("asks again after a signal killed the read", async () => {
		const remotes = failing(
			"--get-regexp",
			{ code: 137, stdout: "", stderr: "git was killed by SIGKILL." },
			1,
		);
		const bound = await engineOver(remotes.exec).fromLocal("/src/world", range);
		expect(
			bound.repo.key,
			"a killed read is never taken as no remotes, and the second answer binds",
		).toBe("github:Shopify/world");
		expect(remotes.asked(), "a killed read is asked twice").toBe(2);
	});

	it("refuses a stopped call without advice to ask again", async () => {
		const remotes = failing(
			"--get-regexp",
			{ code: 130, stdout: "", stderr: "aborted before it started" },
			1,
		);
		const refused = engineOver(remotes.exec).fromLocal("/src/world", range);
		await expect(refused, "a stopped call says so").rejects.toThrow(
			/The call was stopped before git answered\.$/,
		);
		expect(remotes.asked(), "a stopped call is asked only once").toBe(1);
	});

	it("refuses a checkout git will not read, not keying it by path", async () => {
		const top = failing(
			"--show-toplevel",
			{
				code: 128,
				stdout: "",
				stderr:
					"fatal: detected dubious ownership in repository at '/src/world'\n",
			},
			1,
		);
		await expect(
			engineOver(top.exec).fromLocal("/src/world", range),
			"a git fatal other than outside a repo is refused, naming it",
		).rejects.toThrow(
			/could not say whether \/src\/world is a checkout: fatal: detected dubious ownership.*will fail the same way/,
		);
		expect(top.asked(), "a git fatal is asked only once").toBe(1);
	});

	it("refuses a checkout whose top git could not say twice", async () => {
		const top = failing("--show-toplevel", couldNotStart, 2);
		await expect(
			engineOver(top.exec).fromLocal("/src/world", range),
			"an unread top is refused rather than taken as outside a repo",
		).rejects.toThrow(/could not say whether \/src\/world is a checkout/);
		expect(top.asked(), "a git that could not start is asked twice").toBe(2);
	});

	it("refuses to say who serves a checkout whose remotes went unread", async () => {
		const engine = engineOver(failing("--get-regexp", couldNotStart, 2).exec);
		await expect(
			engine.serving("/src/world"),
			"serving refuses as fromLocal does",
		).rejects.toThrow(/could not read the remotes of \/src\/world/);
	});

	it("still resolves a URL there, which needs no checkout", async () => {
		const engine = engineOver(failing("--get-regexp", couldNotStart, 2).exec);
		const bound = await engine.resolve(
			"https://github.com/Shopify/world/pull/123",
			"/src/world",
		);
		expect(bound.repo.key, "a URL names its own repo").toBe(
			"github:Shopify/world",
		);
	});

	it("refuses a bare number there rather than keying it by path", async () => {
		const engine = engineOver(failing("--get-regexp", couldNotStart, 2).exec);
		await expect(
			engine.resolve("123", "/src/world"),
			"a number read against an unread checkout is refused",
		).rejects.toThrow(/could not read the remotes of \/src\/world/);
	});

	it("refuses a number there whose top git could not say", async () => {
		const engine = engineOver(
			failing("--show-toplevel", couldNotStart, 2).exec,
		);
		await expect(
			engine.resolve("123", "/src/world"),
			"a number read where the checkout itself is unread is refused",
		).rejects.toThrow(/could not say whether \/src\/world is a checkout/);
	});

	it("refuses a number there that only a configured pattern would claim", async () => {
		const exec = failing("--get-regexp", couldNotStart, 2).exec;
		registerReviewProvider(createGitHubProvider({ exec }));
		registerReviewProvider(createGitProvider({ exec }));
		const engine = createReviewEngine({
			exec,
			store: createDraftStore(root),
			config: {
				references: [
					{
						pattern: "^(?<id>\\d+)$",
						provider: "github",
						repo: "Shopify/main",
					},
				],
			},
		});
		await expect(
			engine.resolve("123", "/src/world"),
			"a catch-all pattern doesn't bind a number to another repo past an unread checkout",
		).rejects.toThrow(/could not read the remotes of \/src\/world/);
	});

	it("reads a checkout with no remotes at all as plain git", async () => {
		const engine = engineOver(
			fakeExec([
				{ when: ["--show-toplevel"], stdout: "/src/app\n" },
				{ when: ["--get-regexp"], code: 1 },
			]).exec,
		);
		const bound = await engine.fromLocal("/src/app", {
			base: "main",
			head: "topic",
		});
		expect(
			bound.provider.id,
			"git config's no-match answer is no remotes, not a failure",
		).toBe("git");
	});
});

describe("resolving a reference", () => {
	it("binds a pull request URL to the GitHub provider", async () => {
		const { engine } = engineWith([{ when: ["pulls/123"], stdout: pullJson }]);
		const bound = await engine.resolve(
			"https://github.com/Shopify/world/pull/123",
		);
		expect(bound.provider.id).toBe("github");
		expect(bound.target.kind).toBe("change");
		expect(bound.capabilities.conversation).toMatchObject({
			anchoredBatchReview: true,
		});
	});

	it("reads a bare number against the checkout it was asked from", async () => {
		const { engine } = engineWith([
			...inCheckout,
			{ when: ["pulls/123"], stdout: pullJson },
		]);
		const bound = await engine.resolve("123", "/src/world");
		expect(bound.provider.id).toBe("github");
		expect(bound.target.kind === "change" && bound.target.change.id).toBe(
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
		expect(model.files[0]?.newPath).toBe("x.ts");
	});

	it("offers the provider's conversation", async () => {
		const { engine } = engineWith([{ when: ["pulls/123"], stdout: pullJson }]);
		const bound = await engine.resolve(
			"https://github.com/Shopify/world/pull/123",
		);
		expect(
			bound.conversation,
			"a pull request offers the provider's conversation",
		).toBeTruthy();
	});
});

describe("binding a change already known", () => {
	it("binds to the system the change names", async () => {
		// The caller resolved this once already. Re-resolving its name
		// can reach a different provider, because claiming depends on
		// which directory the question is asked from.
		const { exec } = fakeExec([{ when: ["api"], stdout: pullJson }]);
		registerReviewProvider(stubProvider({ id: "elsewhere", priority: 10 }));
		registerReviewProvider(createGitHubProvider({ exec }));
		const engine = createReviewEngine({ exec, store: createDraftStore(root) });

		const bound = await engine.bound({
			provider: "github",
			repo: { key: "github:Shopify/world" },
			id: "123",
			label: "Shopify/world#123",
		});

		expect(bound.provider.id).toBe("github");
	});

	it("does not consult any other provider's claim", async () => {
		// A provider registered at a keener priority would win a
		// resolution by name. It must not win here.
		const { exec } = fakeExec([{ when: ["api"], stdout: pullJson }]);
		registerReviewProvider(
			stubProvider({
				id: "greedy",
				priority: 1,
				claimReference: () => ({
					provider: "greedy",
					repo: { key: "greedy:Shopify/world" },
					id: "123",
					label: "Shopify/world#123",
				}),
			}),
		);
		registerReviewProvider(createGitHubProvider({ exec }));
		const engine = createReviewEngine({ exec, store: createDraftStore(root) });

		const bound = await engine.bound({
			provider: "github",
			repo: { key: "github:Shopify/world" },
			id: "123",
			label: "Shopify/world#123",
		});

		expect(bound.provider.id).toBe("github");
	});

	it("says which system is missing when it is not registered", async () => {
		// The likely cause is an extension that did not load, and
		// naming the system is what points at it.
		const { exec } = fakeExec([]);
		registerReviewProvider(createGitHubProvider({ exec }));
		const engine = createReviewEngine({ exec, store: createDraftStore(root) });

		await expect(
			engine.bound({
				provider: "meteorite",
				repo: { key: "meteorite:shop/world" },
				id: "7",
				label: "shop/world#7",
			}),
		).rejects.toThrow(/meteorite/);
	});

	it("reads the change through the provider it bound", async () => {
		const { exec } = fakeExec([{ when: ["api"], stdout: pullJson }]);
		registerReviewProvider(createGitHubProvider({ exec }));
		const engine = createReviewEngine({ exec, store: createDraftStore(root) });

		const bound = await engine.bound({
			provider: "github",
			repo: { key: "github:Shopify/world" },
			id: "123",
			label: "Shopify/world#123",
		});

		expect((await bound.proposal())?.title).toBe("A change");
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

	it("reads a base that has fallen behind its upstream at the upstream's tip, keeping its name", async () => {
		const { engine } = engineWith([
			...localRepo,
			{ when: ["refs/heads/main^{commit}"], stdout: "old\n" },
			// Before the name's rule, which its words would also match.
			{ when: ["main@{upstream}^{commit}"], stdout: "new\n" },
			{ when: ["main@{upstream}"], stdout: "origin/main\n" },
			{ when: ["--is-ancestor", "old", "new"] },
			{ when: ["rev-list", "--count", "old..new"], stdout: "3\n" },
			{ when: ["diff", "new...topic"], stdout: "diff --git a/y b/y\n" },
		]);
		const bound = await engine.fromLocal("/src/app", {
			base: "main",
			head: "topic",
		});
		expect(bound.target).toMatchObject({
			kind: "range",
			base: "main",
			upstream: { ref: "origin/main", commit: "new", behind: 3 },
		});
		expect(await bound.diff()).toContain("diff --git a/y");
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
		expect(stack?.nodes[0]?.ref).toBe("topic");
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

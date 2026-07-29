import { describe, expect, it } from "vitest";
import { type ChangeRef, createGitHubProvider } from "../../../lib/review";
import { callMatching, fakeExec, type Reply } from "./support/fake-exec.js";

const repo = { key: "github:Shopify/world" };
const ref: ChangeRef = {
	provider: "github",
	repo,
	id: "123",
	label: "Shopify/world#123",
};

const pullJson = JSON.stringify({
	number: 123,
	title: "Teach the widget to fly",
	body: "### 🌐 Situation\nIt cannot fly.",
	state: "open",
	draft: false,
	merged_at: null,
	user: { login: "someone" },
	base: { ref: "main" },
	head: { ref: "widget-flight", sha: "abc1234" },
	html_url: "https://github.com/Shopify/world/pull/123",
	created_at: "2026-07-01T00:00:00Z",
	updated_at: "2026-07-02T00:00:00Z",
});

function provider(replies: Reply[]) {
	const { exec, calls } = fakeExec(replies);
	return { provider: createGitHubProvider({ exec }), calls };
}

describe("how big the change is", () => {
	// Reported so a consumer can say "120 files, +13841 -11215"
	// without fetching and counting a whole diff to find out.
	it("reads the size from REST, which spells it changed_files", async () => {
		const { provider: gh } = provider([
			{
				when: ["repos/Shopify/world/pulls/123"],
				stdout: JSON.stringify({
					...JSON.parse(pullJson),
					additions: 13841,
					deletions: 11215,
					changed_files: 120,
				}),
			},
		]);

		const proposal = await gh.proposals?.fetch(ref);

		expect(proposal?.additions).toBe(13841);
		expect(proposal?.deletions).toBe(11215);
		expect(proposal?.changedFiles).toBe(120);
	});

	it("attributes a deleted author to GitHub's ghost", async () => {
		// GitHub nulls the author once the account is gone and
		// reassigns the content to the ghost user, so reporting ghost
		// is repeating the forge rather than inventing a placeholder.
		const { provider: gh } = provider([
			{
				when: ["repos/Shopify/world/pulls/123"],
				stdout: JSON.stringify({ ...JSON.parse(pullJson), user: null }),
			},
		]);

		const proposal = await gh.proposals?.fetch(ref);

		expect(proposal?.author.id).toBe("ghost");
	});

	it("says nothing about size when the answer carries none", async () => {
		// A count of zero and an unreported count are different
		// things, and one of them must not be printed as the other.
		const { provider: gh } = provider([
			{ when: ["repos/Shopify/world/pulls/123"], stdout: pullJson },
		]);

		const proposal = await gh.proposals?.fetch(ref);

		expect(proposal?.additions).toBeUndefined();
		expect(proposal?.changedFiles).toBeUndefined();
	});
});

describe("reading a pull request", () => {
	it("asks gh for the pull request and maps it to a proposal", async () => {
		const { provider: gh, calls } = provider([
			{ when: ["repos/Shopify/world/pulls/123"], stdout: pullJson },
		]);
		const proposal = await gh.proposals?.fetch(ref);
		expect(callMatching(calls, "api")?.command).toBe("gh");
		expect(proposal?.title).toBe("Teach the widget to fly");
		expect(proposal?.state).toBe("open");
		expect(proposal?.draft).toBe(false);
		expect(proposal?.author.id).toBe("someone");
		expect(proposal?.base).toBe("main");
		expect(proposal?.head).toBe("widget-flight");
		expect(proposal?.headCommit).toBe("abc1234");
		expect(proposal?.url).toContain("/pull/123");
	});

	it("reads a merged pull request as merged, not closed", async () => {
		const merged = JSON.stringify({
			...JSON.parse(pullJson),
			state: "closed",
			merged_at: "2026-07-03T00:00:00Z",
		});
		const { provider: gh } = provider([
			{ when: ["pulls/123"], stdout: merged },
		]);
		expect((await gh.proposals?.fetch(ref))?.state).toBe("merged");
	});

	it("reads a closed pull request that never merged as closed", async () => {
		const closed = JSON.stringify({
			...JSON.parse(pullJson),
			state: "closed",
			merged_at: null,
		});
		const { provider: gh } = provider([
			{ when: ["pulls/123"], stdout: closed },
		]);
		expect((await gh.proposals?.fetch(ref))?.state).toBe("closed");
	});

	it("keeps draft as a flag beside the state, not as a state", async () => {
		const draft = JSON.stringify({ ...JSON.parse(pullJson), draft: true });
		const { provider: gh } = provider([{ when: ["pulls/123"], stdout: draft }]);
		const proposal = await gh.proposals?.fetch(ref);
		expect(proposal?.draft).toBe(true);
		expect(proposal?.state).toBe("open");
	});

	it("explains itself when gh fails", async () => {
		const { provider: gh } = provider([
			{ when: ["pulls/123"], code: 1, stderr: "gh: not found" },
		]);
		await expect(gh.proposals?.fetch(ref)).rejects.toThrow(/not found/);
	});
});

describe("reading the diff", () => {
	it("asks gh for a unified diff", async () => {
		const diff = "diff --git a/x b/x\n";
		const { provider: gh, calls } = provider([
			{ when: ["diff", "123"], stdout: diff },
		]);
		expect(await gh.proposals?.diff(ref)).toBe(diff);
		expect(callMatching(calls, "diff")?.args).toContain("Shopify/world");
	});
});

describe("reading checks", () => {
	const rollup = JSON.stringify({
		statusCheckRollup: [
			{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
			{ name: "flaky", status: "COMPLETED", conclusion: "FAILURE" },
			{ name: "slow", status: "IN_PROGRESS", conclusion: null },
			{ context: "legacy", state: "SUCCESS" },
		],
	});

	it("reports each check and rolls them up", async () => {
		const { provider: gh } = provider([
			{ when: ["statusCheckRollup"], stdout: rollup },
		]);
		const checks = await gh.proposals?.checks?.(ref);
		expect(checks?.checks.map((entry) => entry.name)).toEqual([
			"build",
			"flaky",
			"slow",
			"legacy",
		]);
		expect(checks?.checks[0].state).toBe("passing");
		expect(checks?.checks[1].state).toBe("failing");
		expect(checks?.checks[2].state).toBe("pending");
		expect(checks?.state).toBe("failing");
	});

	it("rolls up to pending while anything is still running", async () => {
		const running = JSON.stringify({
			statusCheckRollup: [
				{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
				{ name: "slow", status: "QUEUED", conclusion: null },
			],
		});
		const { provider: gh } = provider([
			{ when: ["statusCheckRollup"], stdout: running },
		]);
		expect((await gh.proposals?.checks?.(ref))?.state).toBe("pending");
	});

	it("says nothing has reported rather than claiming success", async () => {
		const { provider: gh } = provider([
			{ when: ["statusCheckRollup"], stdout: '{"statusCheckRollup":[]}' },
		]);
		const checks = await gh.proposals?.checks?.(ref);
		expect(checks?.state).toBe("unreported");
		expect(checks?.checks).toEqual([]);
	});
});

describe("listing changes", () => {
	const listJson = JSON.stringify([
		{
			number: 1,
			title: "One",
			body: "",
			state: "OPEN",
			isDraft: false,
			author: { login: "a" },
			baseRefName: "main",
			headRefName: "one",
			url: "https://github.com/Shopify/world/pull/1",
		},
	]);

	it("maps a listing onto proposals", async () => {
		const { provider: gh, calls } = provider([
			{ when: ["pr", "list"], stdout: listJson },
		]);
		const found = await gh.proposals?.list?.(repo, { state: "open" });
		expect(found?.[0].title).toBe("One");
		expect(found?.[0].state).toBe("open");
		expect(found?.[0].ref.id).toBe("1");
		expect(callMatching(calls, "list")?.args).toContain("--state");
	});

	it("passes a head filter through", async () => {
		const { provider: gh, calls } = provider([
			{ when: ["pr", "list"], stdout: "[]" },
		]);
		await gh.proposals?.list?.(repo, { head: "topic", limit: 5 });
		const args = callMatching(calls, "list")?.args.join(" ");
		expect(args).toContain("topic");
		expect(args).toContain("5");
	});
});

describe("materializing a change locally", () => {
	it("fetches the pull ref and reports where it landed", async () => {
		const { provider: gh, calls } = provider([{ when: ["fetch"] }]);
		const landed = await gh.proposals?.fetchAsRef?.(ref, "/src/world");
		expect(landed).toContain("123");
		const fetch = callMatching(calls, "fetch");
		expect(fetch?.command).toBe("git");
		expect(fetch?.args.join(" ")).toContain("pull/123/head");
		expect(fetch?.args.join(" ")).toContain("/src/world");
	});
});

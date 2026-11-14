import { describe, expect, it } from "vitest";
import {
	changeOf,
	type GitFacts,
	repoOfUrl,
	settle,
	writeInTool,
	writesInBash,
} from "../../../../lib/internal/pineapple/writes.ts";

const HERE = "/work/shop";
const TREES = "/trees";

describe("writesInBash", () => {
	it("sees no write in reads, builds and commits", () => {
		for (const command of [
			"git status && git log --oneline",
			"git commit -m 'fix: it'",
			"gh pr view 12",
			"gh pr checks 12",
			"dt pr diff 12",
			"gh api repos/example/shop/pulls/12",
			"nix build .#checks",
			"echo git push",
		]) {
			expect(writesInBash(command, HERE), command).toEqual([]);
		}
	});

	it("reads a push's remote and branch, and where it runs", () => {
		expect(writesInBash("cd /other && git push origin fix-it", HERE)).toEqual([
			{
				action: "git push",
				kind: "change",
				dir: "/other",
				remote: "origin",
				branch: "fix-it",
			},
		]);
		expect(
			writesInBash("git -C sub push -u origin HEAD:refs/heads/x", HERE),
		).toEqual([
			{
				action: "git push",
				kind: "change",
				dir: "/work/shop/sub",
				remote: "origin",
				branch: "x",
			},
		]);
		expect(writesInBash("git push", HERE)).toEqual([
			{ action: "git push", kind: "change", dir: HERE },
		]);
		expect(
			writesInBash("git push https://github.com/Example/Shop.git +b", HERE),
		).toEqual([
			{
				action: "git push",
				kind: "change",
				dir: HERE,
				repo: "example/shop",
				branch: "b",
			},
		]);
	});

	it("reads a pull request's writes through gh and dt", () => {
		expect(writesInBash("gh pr merge 12 --squash", HERE)).toEqual([
			{ action: "gh pr merge", kind: "change", dir: HERE, pr: 12 },
		]);
		expect(
			writesInBash(
				'gh pr comment https://github.com/example/shop/pull/12 --body "/merge"',
				HERE,
			),
		).toEqual([
			{
				action: "gh pr comment",
				kind: "change",
				dir: HERE,
				repo: "example/shop",
				pr: 12,
			},
		]);
		expect(writesInBash("gh pr ready -R example/shop fix-it", HERE)).toEqual([
			{
				action: "gh pr ready",
				kind: "change",
				dir: HERE,
				repo: "example/shop",
				branch: "fix-it",
			},
		]);
		expect(writesInBash("gh pr create --title t --body b", HERE)).toEqual([
			{ action: "gh pr create", kind: "repo", dir: HERE },
		]);
		expect(writesInBash("dt pr review 7 --approve", HERE)).toEqual([
			{ action: "dt pr review", kind: "change", dir: HERE, pr: 7 },
		]);
		expect(writesInBash("dt submit", HERE)).toEqual([
			{ action: "dt submit", kind: "change", dir: HERE },
		]);
		expect(
			writesInBash(
				"gh api -X POST repos/example/shop/issues/12/comments -f body=x",
				HERE,
			),
		).toEqual([
			{
				action: "gh api",
				kind: "change",
				dir: HERE,
				repo: "example/shop",
				pr: 12,
			},
		]);
	});

	it("sees through the words that run another command", () => {
		expect(writesInBash("timeout 60 env A=1 git push", HERE)).toHaveLength(1);
		expect(writesInBash("direnv exec . gh pr merge 3", HERE)[0]?.pr).toBe(3);
	});

	it("reads a switch or deploy as a write to the machine", () => {
		expect(writesInBash("switch-system", HERE)).toEqual([
			{ action: "switch-system", kind: "machine" },
		]);
		expect(writesInBash("nixos-rebuild switch --flake .", HERE)).toEqual([
			{ action: "nixos-rebuild switch", kind: "machine" },
		]);
		expect(writesInBash("nixos-rebuild build", HERE)).toEqual([]);
	});

	it("finds a write by pattern in a line the command model can't read", () => {
		const writes = writesInBash(
			"for b in a c; do git push origin $b; done",
			HERE,
		);
		expect(writes.map((write) => write.action)).toContain("git push");
	});
});

describe("writeInTool", () => {
	it("reads the review tools' change and repo", () => {
		expect(
			writeInTool(
				"review_offer",
				{ action: "merge", change: "https://github.com/Example/Shop/pull/12" },
				HERE,
				TREES,
			),
		).toEqual({
			action: "review_offer merge",
			kind: "change",
			dir: HERE,
			repo: "example/shop",
			pr: 12,
		});
		expect(
			writeInTool("review_say", { action: "reply", change: "7" }, HERE, TREES),
		).toEqual({
			action: "review_say reply",
			kind: "change",
			dir: HERE,
			pr: 7,
		});
	});

	it("reads a proposal as a write to the repository from its head", () => {
		expect(
			writeInTool(
				"review_offer",
				{ action: "propose", head: "fix-it", repo: "/t" },
				HERE,
				TREES,
			),
		).toEqual({
			action: "review_offer propose",
			kind: "repo",
			dir: "/t",
			branch: "fix-it",
		});
	});

	it("reads only the work tool's push, from its tree", () => {
		expect(
			writeInTool("work", { action: "record" }, HERE, TREES),
		).toBeUndefined();
		expect(
			writeInTool("work", { action: "push", tree: "shop-fix" }, HERE, TREES),
		).toEqual({
			action: "work push",
			kind: "change",
			dir: "/trees/shop-fix",
		});
	});

	it("sees no write in reading tools", () => {
		expect(
			writeInTool("review_see", { action: "diff" }, HERE, TREES),
		).toBeUndefined();
		expect(
			writeInTool("review_draft", { action: "compose" }, HERE, TREES),
		).toBeUndefined();
		expect(writeInTool("read", { path: "x" }, HERE, TREES)).toBeUndefined();
	});
});

describe("settle", () => {
	const git: GitFacts = {
		repoOf: async (dir, remote) =>
			dir === HERE && remote === "origin" ? "example/shop" : undefined,
		branchOf: async () => "fix-it",
	};

	it("fills in the repository and branch the call left to its checkout", async () => {
		expect(
			await settle({ action: "git push", kind: "change", dir: HERE }, git),
		).toEqual({
			action: "git push",
			kind: "change",
			dir: HERE,
			repo: "example/shop",
			branch: "fix-it",
		});
	});

	it("leaves a named change's branch alone, and the machine's writes as they are", async () => {
		const merge = await settle(
			{ action: "gh pr merge", kind: "change", dir: HERE, pr: 12 },
			git,
		);
		expect(merge.branch).toBeUndefined();
		expect(
			await settle({ action: "switch-system", kind: "machine" }, git),
		).toEqual({
			action: "switch-system",
			kind: "machine",
		});
	});
});

describe("references", () => {
	it("reads a remote's owner and name from any form of URL", () => {
		expect(repoOfUrl("git@github.com:Example/Shop.git")).toBe("example/shop");
		expect(repoOfUrl("https://github.com/example/shop")).toBe("example/shop");
		expect(repoOfUrl("ssh://git@code.example.com/example/shop.git")).toBe(
			"example/shop",
		);
		expect(repoOfUrl("shop")).toBeUndefined();
	});

	it("reads a change from a link, owner/name#N, #N or N", () => {
		expect(
			changeOf("https://code.example.com/example/shop/pull/12/files"),
		).toEqual({
			repo: "example/shop",
			pr: 12,
		});
		expect(changeOf("example/shop#12")).toEqual({
			repo: "example/shop",
			pr: 12,
		});
		expect(changeOf("#12")).toEqual({ pr: 12 });
		expect(changeOf("12")).toEqual({ pr: 12 });
		expect(changeOf("fix-it")).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import {
	covering,
	type HeadOf,
	type Here,
} from "../../../../lib/internal/pineapple/cover.ts";
import {
	reachOf,
	type Stop,
} from "../../../../lib/internal/pineapple/stops.ts";
import type { Write } from "../../../../lib/internal/pineapple/writes.ts";

const HERE: Here = { realm: "work", quests: ["QEST-CHILD", "QEST-PARENT"] };
const heads: HeadOf = async (repo, pr) =>
	repo === "example/shop" && pr === 12 ? "fix-it" : undefined;

function stop(...reaches: string[]): Stop {
	return {
		id: reaches.join(","),
		shadow: false,
		reaches: reaches.map(reachOf),
	};
}

async function held(write: Write, ...reaches: string[]): Promise<boolean> {
	return (await covering(write, [stop(...reaches)], HERE, heads)).length > 0;
}

const merge12: Write = {
	action: "gh pr merge",
	kind: "change",
	dir: "/w",
	repo: "example/shop",
	pr: 12,
};
const pushFix: Write = {
	action: "git push",
	kind: "change",
	dir: "/w",
	repo: "example/shop",
	branch: "fix-it",
};
const pushOther: Write = { ...pushFix, branch: "other" };
const switching: Write = { action: "switch-system", kind: "machine" };

describe("a stop on one pull request", () => {
	it("holds writes to that change and pushes to its branch", async () => {
		expect(await held(merge12, "pr:example/shop#12")).toBe(true);
		expect(await held(pushFix, "pr:example/shop#12")).toBe(true);
	});

	it("leaves the session its other work", async () => {
		expect(await held({ ...merge12, pr: 13 }, "pr:example/shop#12")).toBe(
			false,
		);
		expect(await held(pushOther, "pr:example/shop#12")).toBe(false);
		expect(
			await held({ ...merge12, repo: "example/other" }, "pr:example/shop#12"),
		).toBe(false);
		expect(await held(switching, "pr:example/shop#12")).toBe(false);
	});

	it("holds a write it can't tell apart, and says why", async () => {
		const [found] = await covering(
			{ ...pushFix, repo: "example/shop", branch: "x" },
			[stop("pr:example/shop#99")],
			HERE,
			heads,
		);
		expect(found?.because).toMatch(/couldn't be found/);
		expect(
			await held({ action: "git push", kind: "change" }, "pr:example/shop#12"),
		).toBe(true);
	});

	it("whose repository wasn't named holds that number in any", async () => {
		expect(await held({ ...merge12, repo: "example/other" }, "pr:#12")).toBe(
			true,
		);
	});
});

describe("wider stops", () => {
	it("a branch holds pushes to it and writes to its change", async () => {
		expect(await held(pushFix, "branch:example/shop@fix-it")).toBe(true);
		expect(await held(merge12, "branch:example/shop@fix-it")).toBe(true);
		expect(await held(pushOther, "branch:example/shop@fix-it")).toBe(false);
	});

	it("a repository holds every write to it, by full or bare name", async () => {
		expect(await held(pushOther, "repo:example/shop")).toBe(true);
		expect(await held(pushOther, "repo:shop")).toBe(true);
		expect(await held(pushOther, "repo:example/other")).toBe(false);
		expect(await held(switching, "repo:example/shop")).toBe(false);
	});

	it("a quest holds the writes of a session in it or under it", async () => {
		expect(await held(pushOther, "quest:QEST-PARENT")).toBe(true);
		expect(await held(pushOther, "quest:QEST-ELSE")).toBe(false);
	});

	it("a realm holds the session's writes and switches, in its realm only", async () => {
		expect(await held(switching, "realm:work")).toBe(true);
		expect(await held(pushOther, "realm:personal")).toBe(false);
	});

	it("a bare name holds a write whose repository, branch or folder carries it", async () => {
		expect(await held(pushOther, "named:shop")).toBe(true);
		expect(await held(pushOther, "named:aquifer")).toBe(false);
		expect(
			await held({ ...pushOther, dir: "/trees/aquifer-demo" }, "named:aquifer"),
		).toBe(true);
	});

	it("everything holds every write", async () => {
		for (const write of [merge12, pushOther, switching]) {
			expect(await held(write, "everything")).toBe(true);
		}
	});
});

it("names the first reach of each stop that holds the write", async () => {
	const found = await covering(
		pushFix,
		[
			stop("repo:example/other", "pr:example/shop#12"),
			stop("repo:example/other"),
		],
		HERE,
		heads,
	);
	expect(found.map(({ reach }) => reach)).toEqual([
		{ kind: "pr", repo: "example/shop", number: 12 },
	]);
});

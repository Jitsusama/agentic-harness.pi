import { describe, expect, it } from "vitest";
import {
	ANSWERED_FOR_MS,
	answerable,
	answeringFetch,
	fetchedGit,
	movedMain,
	readsMain,
} from "../../../../lib/internal/priority/fetched.ts";
import {
	fetchHeadLine,
	mainFetchOf,
	pathPast,
	// biome-ignore lint/correctness/useImportExtensions: Biome reads the .d.mts beside this .mjs as the module and asks for .mjs.mts, a file that doesn't exist.
} from "../../../../lib/internal/priority/fetched-git.mjs";
import {
	NOTHING_BESIDE,
	type Outcome,
} from "../../../../lib/internal/priority/outcome.ts";
import type { Job } from "../../../../lib/internal/priority/queue.ts";

const NOW = Date.parse("2026-11-05T21:03:00Z");
const A = "a".repeat(40);
const B = "b".repeat(40);

function outcome(id: string, over: Partial<Outcome> = {}): Outcome {
	return {
		v: 1,
		id,
		kind: "world-walk",
		class: "bulk",
		what: "git fetch origin main",
		session: "s",
		asked: new Date(NOW - 300_000).toISOString(),
		started: new Date(NOW - 250_000).toISOString(),
		ended: new Date(NOW - 10_000).toISOString(),
		waitedS: 50,
		ranS: 240,
		capped: false,
		beside: NOTHING_BESIDE,
		walk: "main-fetch",
		movedMain: true,
		...over,
	};
}

describe("a fetch of World's main answered by one just made", () => {
	it("is answered by the last fetch of main to move origin/main, for a minute after it ends", () => {
		expect(answeringFetch([outcome("made")], NOW)?.id).toBe("made");
		const late = NOW + ANSWERED_FOR_MS;
		expect(answeringFetch([outcome("made")], late)).toBeUndefined();
		for (const unmoved of [
			outcome("same", { movedMain: undefined }),
			outcome("push", { walk: "push" }),
			outcome("answered", { answered: true, movedMain: undefined }),
		]) {
			expect(answeringFetch([unmoved], NOW), unmoved.id).toBeUndefined();
		}
	});

	it("answers only fetches of main still waiting for their turn", () => {
		const job = (id: string, over: Partial<Job> = {}): Job => ({
			id,
			kind: "world-walk",
			what: "git fetch origin main",
			walk: "main-fetch",
			owner: { session: "s", pid: 1 },
			since: new Date(NOW).toISOString(),
			...over,
		});
		const jobs = [
			job("waiting"),
			job("running", { started: new Date(NOW).toISOString() }),
			job("review", { walk: "other" }),
			job("planning", { planning: true }),
		];
		expect(answerable(jobs).map((one) => one.id)).toEqual(["waiting"]);
	});

	it("takes a fetch to have moved main only when its last reading is a new commit", () => {
		expect(
			movedMain(`${A}\n`, `${B}\n`),
			"a fetch that ends on another commit moved main",
		).toBe(true);
		expect(
			movedMain("", `${B}\n`),
			"a fetch that finds a commit where there was none moved main",
		).toBe(true);
		expect(
			movedMain(`${A}\n`, `${A}\n`),
			"a fetch that ends on the same commit did not move main",
		).toBe(false);
		expect(
			movedMain(`${A}\n`, ""),
			"a fetch whose last reading is empty did not move main",
		).toBe(false);
		expect(
			movedMain(`${A}\n`, "fatal: not a git repository\n"),
			"a fetch whose last reading is an error did not move main",
		).toBe(false);
	});

	it("reads origin/main from World's repository, quietly", () => {
		expect(readsMain("/home/j/world/git", "'/q/x.main-after'")).toBe(
			"{ timeout 10 git --git-dir='/home/j/world/git' rev-parse -q --verify refs/remotes/origin/main > '/q/x.main-after'; } 2>/dev/null || :",
		);
	});

	it("runs fetched-git.mjs as git with this node, told its folder and World's repository", () => {
		expect(
			fetchedGit("/home/j/world/git", "/bin/node", "/p/fetched-git.mjs"),
		).toBe(
			`#!/bin/sh\nexec '/bin/node' '/p/fetched-git.mjs' "\${0%/*}" '/home/j/world/git' "$@"\n`,
		);
		expect(
			fetchedGit("/home/j/it's/git", "/bin/node", "/p/x.mjs"),
		).toBeUndefined();
	});
});

describe("fetched-git.mjs reading a git command line", () => {
	it("reads a plain fetch of origin's main, past -C, -c and its quiet options", () => {
		expect(mainFetchOf(["fetch", "origin", "main"])).toEqual({
			at: undefined,
			quiet: false,
			writesHead: true,
		});
		expect(
			mainFetchOf([
				"-C",
				"/w/a",
				"-C",
				"src",
				"-c",
				"fetch.uriProtocols=https",
				"fetch",
				"-q",
				"--no-tags",
				"--no-write-fetch-head",
				"origin",
				"+refs/heads/main:refs/remotes/origin/main",
			]),
		).toEqual({ at: "/w/a/src", quiet: true, writesHead: false });
	});

	it("leaves anything else to the real git", () => {
		for (const other of [
			["fetch", "origin"],
			["fetch", "origin", "main", "river/x"],
			["fetch", "delta", "main"],
			["fetch", "--prune", "origin", "main"],
			["fetch", "--depth=1", "origin", "main"],
			["--git-dir=/w", "fetch", "origin", "main"],
			["pull", "origin", "main"],
			["rev-parse", "HEAD"],
			["-C"],
		]) {
			expect(mainFetchOf(other), other.join(" ")).toBeUndefined();
		}
	});

	it("writes FETCH_HEAD's line as git does, without credentials or .git", () => {
		expect(fetchHeadLine(A, "https://u:t@delta.example/shop/world.git/")).toBe(
			`${A}\t\tbranch 'main' of https://delta.example/shop/world\n`,
		);
	});

	it("finds the real git on the PATH past its own folder", () => {
		expect(pathPast("/q/fetched:/bin::/usr/bin:/q/fetched", "/q/fetched")).toBe(
			"/bin:/usr/bin",
		);
	});
});

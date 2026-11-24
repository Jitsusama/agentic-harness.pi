/**
 * git run in a tree as arrive runs it, through real git and sh: fed its
 * input, and stopped once a call to a remote runs past its time. And a
 * tree's origin branches held to an origin that moves under it.
 */

import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../../../../lib/core/exec/index.ts";
import { spawnExec } from "../../../../lib/core/exec/index.ts";
import {
	gitIn,
	holdToOrigin,
	type ViewGit,
} from "../../../../lib/internal/carry/origin-view.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	bareOrigin,
	cloneAt,
	commit,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

const made: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	removeAll(made);
});

/** What git says of an origin that won't take the call at all. */
const REFUSED: ExecResult = {
	code: 128,
	stdout: "",
	stderr: [
		"remote: this origin is down for the night",
		"fatal: Could not read from remote repository.",
		"",
		"Please make sure you have the correct access rights",
		"and the repository exists.",
	].join("\n"),
};

/** A tree with nothing in it, for git to run in. */
async function tree(): Promise<string> {
	const path = folder(made, "view");
	await git(path, "init", "-q");
	return path;
}

/** A remote that takes the call and never answers, over git's ext. */
const SILENT = ["-c", "protocol.ext.allow=always"];

/** The folders fed input leaves in the tree's .git, which go with it. */
function inputsLeft(path: string): string[] {
	return readdirSync(join(path, ".git")).filter((name) =>
		name.startsWith("carry-in-"),
	);
}

describe("git in a tree, as arrive runs it", () => {
	it("stops a remote that never answers once its time is up, saying so", async () => {
		const path = await tree();
		const started = Date.now();

		const done = await gitIn(exec, path)
			.within(1)
			.run(...SILENT, "ls-remote", "ext::sh -c sleep% 30");

		expect(done.code).not.toBe(0);
		expect(done.stderr).toMatch(/^git was stopped after 1 seconds\./);
		expect(Date.now() - started, "well before the remote would").toBeLessThan(
			15_000,
		);
	});

	it("stops a fed fetch from a remote that never answers, leaving no input behind", async () => {
		const path = await tree();
		const started = Date.now();

		const done = await gitIn(exec, path)
			.within(1)
			.fed(
				["+refs/heads/main:refs/remotes/origin/main"],
				...SILENT,
				"fetch",
				"--stdin",
				"ext::sh -c sleep% 30",
			);

		expect(done.code).not.toBe(0);
		expect(done.stderr).toMatch(/^git was stopped after 1 seconds\./);
		expect(Date.now() - started, "well before the remote would").toBeLessThan(
			15_000,
		);
		expect(inputsLeft(path), "its input is gone").toEqual([]);
	});

	it("lets git that ends in its time say what it said", async () => {
		const path = await tree();

		const done = await gitIn(exec, path)
			.within(30)
			.fed(["one", "two"], "hash-object", "--stdin");

		expect(done.code).toBe(0);
		expect(done.stdout.trim(), "the blob of its lines, each ended").toBe(
			createHash("sha1").update("blob 8\0one\ntwo\n").digest("hex"),
		);
	});

	it("runs fed git in English whatever the machine's language, since what it says is matched", async () => {
		const path = await tree();
		const bin = folder(made, "bin");
		const said = join(bin, "git");
		writeFileSync(said, '#!/bin/sh\necho "LC_ALL=$LC_ALL"\n');
		chmodSync(said, 0o755);
		const german = spawnExec({
			env: { LC_ALL: "de_DE.UTF-8", PATH: `${bin}:${process.env.PATH}` },
		});

		const done = await gitIn(german, path).fed(["one"], "fetch", "--stdin");

		expect(done.stdout.trim()).toBe("LC_ALL=C");
	});
});

/**
 * A bare origin holding `branches`, its HEAD naming the first, and a
 * tree cloned from it before each branch moved on there by a commit of
 * its own. Answers each branch's commit before (`was`) and after (`now`).
 */
async function movedOn(branches: readonly string[]) {
	const [first, ...others] = branches;
	const origin = await bareOrigin(made);
	await git(origin, "branch", "-q", "-m", "main", first ?? "main");
	const url = `file://${origin}`;
	const work = await cloneAt(url, join(folder(made, "work"), "w"));
	for (const branch of others) {
		await git(work, "push", "-q", "origin", `HEAD:${branch}`);
	}
	const path = await cloneAt(url, join(folder(made, "tree"), "t"));
	// As arrive leaves a tree cut from a twin: no pointer to origin's HEAD.
	await git(path, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
	const base = await git(work, "rev-parse", "HEAD");
	const was: Record<string, string> = {};
	const now: Record<string, string> = {};
	for (const branch of branches) {
		was[branch] = base;
		await git(work, "checkout", "-q", "-B", branch, base);
		now[branch] = await commit(work, `${branch}.txt`, "past the tree\n");
		await git(work, "push", "-q", "origin", branch);
	}
	return { origin, path, was, now };
}

/** How a test watches, and steers, git's calls to origin. */
interface Watching {
	/** Each fetch of branches set aside, as the names it asked for. */
	readonly fetched: string[][];
	/** Called once, after origin's first listing. */
	readonly listed?: () => Promise<unknown>;
	/** What asking origin for its trunk answers, in git's place. */
	readonly trunk?: ExecResult;
	/** What a fetch of `names` answers in git's place, or nothing to run git. */
	readonly fetch?: (names: readonly string[]) => ExecResult | undefined;
	/** Called after each fetch, as the time it took. */
	readonly fetchedThen?: () => void;
}

/** git in the tree at `path`, its calls to origin watched as `watching` says. */
function watched(path: string, watching: Watching): ViewGit {
	const real = gitIn(exec, path);
	let first = true;
	return {
		...real,
		within: (seconds) => {
			const timed = real.within(seconds);
			return {
				run: async (...args) => {
					if (watching.trunk !== undefined && args.includes("--symref")) {
						return watching.trunk;
					}
					const done = await timed.run(...args);
					if (first && args.includes("ls-remote")) {
						first = false;
						await watching.listed?.();
					}
					return done;
				},
				fed: async (lines, ...args) => {
					if (!args.includes("fetch")) return timed.fed(lines, ...args);
					const names = lines.map((line) =>
						line.replace(/^\+refs\/heads\/|:.*$/g, ""),
					);
					watching.fetched.push(names);
					const done =
						watching.fetch?.(names) ?? (await timed.fed(lines, ...args));
					watching.fetchedThen?.();
					return done;
				},
			};
		},
	};
}

/** The refs under refs/remotes/ and refs/carry/ in `path`, with their commits. */
function refsIn(path: string): Promise<string> {
	return git(
		path,
		"for-each-ref",
		"--format=%(refname) %(objectname)",
		"refs/remotes/",
		"refs/carry/",
	);
}

describe("holding a tree's origin branches to origin", () => {
	it("asks origin for its branches alone, never its tags or pull refs", async () => {
		const { origin, path } = await movedOn(["main"]);
		await git(origin, "update-ref", "refs/pull/1/head", "main");
		// A ref, not `git tag`, which a machine set to sign tags would sign.
		await git(origin, "update-ref", "refs/tags/v1", "main");
		const trace = join(folder(made, "trace"), "packets");
		const traced = spawnExec({ env: { GIT_TRACE_PACKET: trace } });

		const held = await holdToOrigin(gitIn(traced, path));

		expect(held).toEqual({});
		const packets = readFileSync(trace, "utf8");
		expect(packets, "the listing names its prefix").toContain(
			"ls-remote> ref-prefix refs/heads/\n",
		);
		const sent = [...packets.matchAll(/upload-pack> [0-9a-f]{40} (\S+)/g)].map(
			([, ref]) => ref,
		);
		expect(sent, "the listing, then the fetch, each sent main alone").toEqual([
			"refs/heads/main",
			"refs/heads/main",
		]);
	});

	it("takes origin's trunk first, though it sorts last, when origin drops another branch after listing it", async () => {
		const { origin, path, was, now } = await movedOn(["trunk", "alpha"]);
		const fetched: string[][] = [];

		const held = await holdToOrigin(
			watched(path, {
				fetched,
				listed: () => git(origin, "branch", "-q", "-D", "alpha"),
			}),
		);

		expect(held.why).toBeUndefined();
		expect(fetched, "all at once, then the trunk, then the rest").toEqual([
			["alpha", "trunk"],
			["trunk"],
			["alpha"],
		]);
		expect(await refsIn(path)).toBe(
			[
				`refs/carry/twin/alpha ${was.alpha}`,
				`refs/remotes/origin/trunk ${now.trunk}`,
			].join("\n"),
		);
		expect(held.unsure).toMatch(
			/^1 of origin's branches past the twin didn't come, so they wait under refs\/carry\/twin\/: alpha\. /,
		);
		expect(inputsLeft(path)).toEqual([]);
	});

	it("keeps origin's own order where origin won't name its trunk, failing nothing", async () => {
		const { origin, path, was, now } = await movedOn(["trunk", "alpha"]);
		const fetched: string[][] = [];

		const held = await holdToOrigin(
			watched(path, {
				fetched,
				listed: () => git(origin, "branch", "-q", "-D", "alpha"),
				trunk: { code: 128, stdout: "", stderr: "fatal: the trunk won't say" },
			}),
		);

		expect(held.why).toBeUndefined();
		expect(fetched).toEqual([["alpha", "trunk"], ["alpha"], ["trunk"]]);
		expect(await refsIn(path)).toBe(
			[
				`refs/carry/twin/alpha ${was.alpha}`,
				`refs/remotes/origin/trunk ${now.trunk}`,
			].join("\n"),
		);
	});

	it.each([
		[
			"is detached",
			(origin: string) =>
				git(origin, "update-ref", "--no-deref", "HEAD", "alpha"),
		],
		[
			"names a branch it lacks",
			(origin: string) =>
				git(origin, "symbolic-ref", "HEAD", "refs/heads/nothing"),
		],
	])(
		"keeps origin's own order where its HEAD %s, though a HEAD below names a branch",
		async (_, behead) => {
			const { origin, path, was, now } = await movedOn([
				"alpha",
				"gone",
				"zeta",
			]);
			await behead(origin);
			await git(
				origin,
				"symbolic-ref",
				"refs/remotes/up/HEAD",
				"refs/heads/zeta",
			);
			const fetched: string[][] = [];

			const held = await holdToOrigin(
				watched(path, {
					fetched,
					listed: () => git(origin, "branch", "-q", "-D", "gone"),
				}),
			);

			expect(held.why).toBeUndefined();
			expect(fetched).toEqual([
				["alpha", "gone", "zeta"],
				["alpha"],
				["gone"],
				["zeta"],
			]);
			expect(await refsIn(path)).toBe(
				[
					`refs/carry/twin/gone ${was.gone}`,
					`refs/remotes/origin/alpha ${now.alpha}`,
					`refs/remotes/origin/zeta ${now.zeta}`,
				].join("\n"),
			);
		},
	);

	it("fetches no branch alone where origin refuses the call, leaving each aside with its reason", async () => {
		const { path, was } = await movedOn(["trunk", "alpha", "beta"]);
		const fetched: string[][] = [];

		const held = await holdToOrigin(
			watched(path, { fetched, fetch: () => REFUSED }),
		);

		expect(held.why).toBeUndefined();
		expect(fetched, "one fetch, of them all").toEqual([
			["alpha", "beta", "trunk"],
		]);
		expect(held.unsure).toBe(
			"3 of origin's branches past the twin didn't come, so they wait under refs/carry/twin/: alpha, beta, trunk. fatal: Could not read from remote repository.",
		);
		expect(await refsIn(path)).toBe(
			[
				`refs/carry/twin/alpha ${was.alpha}`,
				`refs/carry/twin/beta ${was.beta}`,
				`refs/carry/twin/trunk ${was.trunk}`,
			].join("\n"),
		);
	});

	it("names the branches its 900 seconds all told ran out before, as that", async () => {
		const { origin, path, was, now } = await movedOn([
			"trunk",
			"alpha",
			"beta",
		]);
		const fetched: string[][] = [];
		vi.useFakeTimers({ toFake: ["Date"] });

		const held = await holdToOrigin(
			watched(path, {
				fetched,
				listed: () => git(origin, "branch", "-q", "-D", "alpha"),
				// Each fetch, as the clock reads it, takes ten minutes.
				fetchedThen: () => vi.setSystemTime(Date.now() + 600_000),
			}),
		);

		expect(held.why).toBeUndefined();
		expect(fetched, "all at once, then the trunk, then no time").toEqual([
			["alpha", "beta", "trunk"],
			["trunk"],
		]);
		expect(held.unsure).toBe(
			"2 of origin's branches past the twin weren't asked for before the 900 seconds all told ran out, so they wait under refs/carry/twin/: alpha, beta.",
		);
		expect(await refsIn(path)).toBe(
			[
				`refs/carry/twin/alpha ${was.alpha}`,
				`refs/carry/twin/beta ${was.beta}`,
				`refs/remotes/origin/trunk ${now.trunk}`,
			].join("\n"),
		);
	});

	it("says git's own reason for each branch that didn't come, stopping where origin stops answering", async () => {
		const { origin, path, was, now } = await movedOn([
			"trunk",
			"alpha",
			"beta",
			"gamma",
		]);
		const fetched: string[][] = [];

		const held = await holdToOrigin(
			watched(path, {
				fetched,
				listed: () => git(origin, "branch", "-q", "-D", "alpha"),
				fetch: (names) => (names[0] === "beta" ? REFUSED : undefined),
			}),
		);

		expect(held.why).toBeUndefined();
		expect(fetched, "gamma is never asked for").toEqual([
			["alpha", "beta", "gamma", "trunk"],
			["trunk"],
			["alpha"],
			["beta"],
		]);
		expect(held.unsure).toBe(
			[
				"1 of origin's branches past the twin didn't come, so they wait under refs/carry/twin/: alpha. fatal: couldn't find remote ref refs/heads/alpha.",
				"2 of origin's branches past the twin didn't come, so they wait under refs/carry/twin/: beta, gamma. fatal: Could not read from remote repository.",
			].join(" "),
		);
		expect(await refsIn(path)).toBe(
			[
				`refs/carry/twin/alpha ${was.alpha}`,
				`refs/carry/twin/beta ${was.beta}`,
				`refs/carry/twin/gamma ${was.gamma}`,
				`refs/remotes/origin/trunk ${now.trunk}`,
			].join("\n"),
		);
	});
});

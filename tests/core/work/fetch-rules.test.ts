/**
 * The work tool's fetches of a checkout whose owner says how: answered
 * from a prefetch where one is kept, run behind a turn where one is
 * named, and as they always were everywhere else.
 *
 * Against real repositories, a bare origin and a clone of it, since
 * what is checked is which commit git's refs hold after the fetch and
 * whether any fetch reached origin at all.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Exec, spawnExec } from "../../../lib/core/exec/index.ts";
import {
	type FetchRule,
	fetchingBy,
	gitFetchOf,
	parseWorkFetches,
} from "../../../lib/core/work/fetch-rules.ts";
import {
	FETCHED_LATELY_MS,
	refreshStart,
} from "../../../lib/core/work/fresh-start.ts";
import { queuedExec } from "../../../lib/internal/priority/queued-exec.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

let seed: string;
let origin: string;
let clone: string;
let place: string;

beforeEach(async () => {
	seed = await freshRepo("fetch-rules-seed");
	place = await freshRepo("fetch-rules-place");
	origin = join(place, "origin.git");
	clone = join(place, "clone");
	await git(place, "clone", "-q", "--bare", seed, origin);
	await git(place, "clone", "-q", origin, clone);
});

afterEach(() => {
	disposeRepo(seed);
	disposeRepo(place);
});

/** A commit made on origin's main, which the clone hasn't fetched. */
async function landedOnOrigin(name: string): Promise<string> {
	writeFileSync(join(seed, name), `${name}\n`);
	await git(seed, "add", name);
	await git(seed, "commit", "-qm", name);
	await git(seed, "push", "-q", origin, "main");
	return git(seed, "rev-parse", "HEAD");
}

/**
 * What the prefetch writes: `commit` under refs/prefetch, brought by
 * its id so that no tracking ref moves with it, as a fetch of origin's
 * main into any ref would move origin/main beside it.
 */
async function prefetched(commit: string, branch = "main"): Promise<void> {
	await git(clone, "fetch", "-q", "origin", commit);
	await git(
		clone,
		"update-ref",
		`refs/prefetch/remotes/origin/${branch}`,
		commit,
	);
}

/** What the clone's ref `ref` holds, or "" when it holds nothing. */
async function held(ref: string): Promise<string> {
	try {
		return await git(clone, "rev-parse", "--verify", "--quiet", ref);
	} catch {
		// No such ref: it holds nothing.
		return "";
	}
}

/** An exec that runs git and remembers every fetch it was asked for. */
function counting(): { exec: Exec; fetches: string[][] } {
	const fetches: string[][] = [];
	const real = spawnExec();
	return {
		fetches,
		exec: (command, args) => {
			if (command === "git" && args.includes("fetch")) fetches.push(args);
			// A fetch run behind a turn reaches git through bash.
			if (command === "bash" && args.includes("fetch")) fetches.push(args);
			return real(command, args);
		},
	};
}

/** Rules naming only the clone, as the `work` section would. */
const naming =
	(rule: FetchRule) =>
	async (gitDir: string): Promise<FetchRule | undefined> =>
		gitDir === realpathSync(join(clone, ".git")) ? rule : undefined;

/**
 * `exec`'s fetches of the clone by `rule`, a turn run as the queue's
 * exec runs it once no queue takes the fetch.
 */
const fetchingOf = (exec: Exec, rule: FetchRule): Exec =>
	fetchingBy(exec, naming(rule), (named, args) =>
		queuedExec(exec, exec, undefined, named.through)("git", [...args]),
	);

const TRACKING = "+refs/heads/main:refs/remotes/origin/main";

describe("a fetch of a checkout kept prefetched", () => {
	it("moves the tracking ref forward to the prefetched commit and asks origin for nothing", async () => {
		const landed = await landedOnOrigin("a");
		await prefetched(landed);
		expect(await held("refs/remotes/origin/main")).not.toBe(landed);
		const run = counting();

		const result = await fetchingOf(run.exec, { prefetched: true })("git", [
			"-C",
			clone,
			"fetch",
			"-q",
			"origin",
			TRACKING,
		]);

		expect(result.code, result.stderr).toBe(0);
		expect(
			await held("refs/remotes/origin/main"),
			"the tracking ref didn't move",
		).toBe(landed);
		expect(
			run.fetches,
			"origin was fetched though the prefetch had it",
		).toEqual([]);
	});

	it("answers `origin main`, as a sync asks, the same way", async () => {
		const landed = await landedOnOrigin("a");
		await prefetched(landed);
		const run = counting();

		await fetchingOf(run.exec, { prefetched: true })("git", [
			"-C",
			clone,
			"fetch",
			"origin",
			"main",
		]);

		expect(await held("refs/remotes/origin/main")).toBe(landed);
		expect(run.fetches).toEqual([]);
	});

	it("never moves the tracking ref back past a fetch newer than the prefetch", async () => {
		const older = await git(clone, "rev-parse", "origin/main");
		await git(clone, "update-ref", "refs/prefetch/remotes/origin/main", older);
		const newer = await landedOnOrigin("b");
		await git(clone, "fetch", "-q", "origin");
		const run = counting();

		await fetchingOf(run.exec, { prefetched: true })("git", [
			"-C",
			clone,
			"fetch",
			"origin",
			"main",
		]);

		expect(
			await held("refs/remotes/origin/main"),
			"the newer fetch was lost",
		).toBe(newer);
		expect(run.fetches).toEqual([]);
	});

	it("fetches a branch the prefetch holds off the line its tracking ref is on, as a force push leaves it", async () => {
		// The clone fetched a commit that origin then lost to a force push,
		// and the prefetch holds the commit that took its place.
		const before = await git(clone, "rev-parse", "origin/main");
		await landedOnOrigin("gone");
		await git(clone, "fetch", "-q", "origin");
		await git(seed, "reset", "-q", "--hard", before);
		writeFileSync(join(seed, "instead"), "instead\n");
		await git(seed, "add", "instead");
		await git(seed, "commit", "-qm", "instead");
		await git(seed, "push", "-q", "--force", origin, "main");
		const rewritten = await git(seed, "rev-parse", "HEAD");
		await prefetched(rewritten);
		const run = counting();

		const result = await fetchingOf(run.exec, { prefetched: true })("git", [
			"-C",
			clone,
			"fetch",
			"-q",
			"origin",
			TRACKING,
		]);

		expect(result.code, result.stderr).toBe(0);
		expect(run.fetches, "the prefetch was trusted off its line").toHaveLength(
			1,
		);
		expect(
			await held("refs/remotes/origin/main"),
			"the ref doesn't hold what origin holds",
		).toBe(rewritten);
	});

	it("fetches when git won't move the tracking ref, rather than say it moved", async () => {
		const landed = await landedOnOrigin("a");
		await prefetched(landed);
		const locked = join(
			clone,
			".git",
			"refs",
			"remotes",
			"origin",
			"main.lock",
		);
		writeFileSync(locked, "");
		const run = counting();

		const result = await fetchingOf(run.exec, { prefetched: true })("git", [
			"-C",
			clone,
			"fetch",
			"-q",
			"origin",
			TRACKING,
		]);

		expect(run.fetches, "a move that failed was answered").toHaveLength(1);
		expect(result.code, "git's own fetch met the same lock").not.toBe(0);
	});

	it("fetches when asked for what an answer doesn't do", async () => {
		const landed = await landedOnOrigin("a");
		await prefetched(landed);
		const run = counting();
		const fetching = fetchingOf(run.exec, { prefetched: true });

		await fetching("git", ["-C", clone, "fetch", "--prune", "origin", "main"]);
		await fetching("git", [
			"-C",
			clone,
			"fetch",
			"origin",
			"main:refs/heads/copy",
		]);

		expect(run.fetches).toHaveLength(2);
		expect(await held("refs/heads/copy")).toBe(landed);
	});

	it("leaves a later start to be answered again, since the prefetch's age isn't known", async () => {
		const landed = await landedOnOrigin("a");
		await prefetched(landed);
		const run = counting();
		const fetching = fetchingOf(run.exec, { prefetched: true });

		const fresh = await refreshStart(
			fetching,
			clone,
			"origin/main",
			undefined,
			{ fetchedWithin: FETCHED_LATELY_MS },
		);
		const again = await refreshStart(
			fetching,
			clone,
			"origin/main",
			undefined,
			{ fetchedWithin: FETCHED_LATELY_MS },
		);

		expect(fresh.stale, "the first start read as stale").toBeUndefined();
		expect(
			again.lately,
			"the move was taken for a fetch made now",
		).toBeUndefined();
		expect(await held("refs/remotes/origin/main")).toBe(landed);
		expect(run.fetches).toEqual([]);
	});

	it("answers a fetch naming no ref, as a snapshot of a short id asks, with nothing fetched", async () => {
		await prefetched(await git(clone, "rev-parse", "origin/main"));
		const run = counting();

		const result = await fetchingOf(run.exec, { prefetched: true })("git", [
			"-C",
			clone,
			"fetch",
			"--quiet",
			"--no-tags",
			"origin",
		]);

		expect(result.code).toBe(0);
		expect(run.fetches, "every branch of origin was fetched").toEqual([]);
	});

	it("fetches a remote nothing was prefetched of, though the rule says it is", async () => {
		const landed = await landedOnOrigin("a");
		const run = counting();

		await fetchingOf(run.exec, { prefetched: true })("git", [
			"-C",
			clone,
			"fetch",
			"--quiet",
			"--no-tags",
			"origin",
		]);

		expect(run.fetches).toHaveLength(1);
		expect(await held(`${landed}^{commit}`)).toBe(landed);
	});

	it("fetches a branch the prefetch doesn't hold", async () => {
		await prefetched(await git(clone, "rev-parse", "origin/main"));
		await git(seed, "push", "-q", origin, "HEAD:refs/heads/other");
		const run = counting();

		await fetchingOf(run.exec, { prefetched: true })("git", [
			"-C",
			clone,
			"fetch",
			"origin",
			"other",
		]);

		expect(run.fetches).toHaveLength(1);
		expect(await held("refs/remotes/origin/other")).not.toBe("");
	});

	it("fetches a commit by its id", async () => {
		await prefetched(await git(clone, "rev-parse", "origin/main"));
		const landed = await landedOnOrigin("a");
		const run = counting();

		await fetchingOf(run.exec, { prefetched: true })("git", [
			"-C",
			clone,
			"fetch",
			"--quiet",
			"--no-tags",
			"origin",
			landed,
		]);

		expect(run.fetches).toHaveLength(1);
		expect(await held(`${landed}^{commit}`)).toBe(landed);
	});
});

describe("a fetch of a checkout whose fetches wait their turn", () => {
	it("runs behind the turn the rule names, and still fetches", async () => {
		const landed = await landedOnOrigin("a");
		const said = join(place, "turn.log");
		const through = `echo "turn for $*" >> '${said}';`;

		const result = await fetchingOf(spawnExec(), { through })("git", [
			"-C",
			clone,
			"fetch",
			"--quiet",
			"origin",
			landed,
		]);

		expect(result.code, result.stderr).toBe(0);
		expect(
			readFileSync(said, "utf8"),
			"the fetch didn't take its turn",
		).toContain(`turn for git -C ${clone} fetch --quiet origin ${landed}`);
		expect(
			await held(`${landed}^{commit}`),
			"the fetch itself didn't run",
		).toBe(landed);
	});

	it("runs behind it inside the queue's exec, after the guard", async () => {
		const asked: [string, string[]][] = [];
		const direct: Exec = (command, args) => {
			asked.push([command, args]);
			return Promise.resolve({ code: 0, stdout: "", stderr: "" });
		};

		await queuedExec(
			direct,
			direct,
			(_, args) => ({ args: ["-c", "x=y", ...args] }),
			"turn",
		)("git", ["-C", clone, "fetch", "origin", "main"]);

		expect(asked).toEqual([
			[
				"bash",
				[
					"-c",
					'turn "$@"',
					"work-fetch",
					"git",
					"-c",
					"x=y",
					"-C",
					clone,
					"fetch",
					"origin",
					"main",
				],
			],
		]);
	});

	it("leaves every other command to run as it is", async () => {
		const run = counting();
		const said = join(place, "turn.log");

		await fetchingOf(run.exec, { through: `echo x >> '${said}';` })("git", [
			"-C",
			clone,
			"status",
			"--short",
		]);

		expect(
			() => readFileSync(said),
			"a command not a fetch took a turn",
		).toThrow();
	});
});

describe("a fetch of a checkout nobody names", () => {
	it("fetches as it always did, though git's maintenance left a prefetch", async () => {
		const landed = await landedOnOrigin("a");
		const stale = await git(clone, "rev-parse", "origin/main");
		await git(clone, "update-ref", "refs/prefetch/remotes/origin/main", stale);
		const run = counting();

		await fetchingBy(
			run.exec,
			async () => undefined,
			() => Promise.reject(new Error("no turn is named")),
		)("git", ["-C", clone, "fetch", "-q", "origin", TRACKING]);

		expect(
			run.fetches,
			"the fetch was answered from a prefetch nobody keeps",
		).toHaveLength(1);
		expect(await held("refs/remotes/origin/main")).toBe(landed);
	});
});

describe("reading what a fetch asks and what the section says", () => {
	it("reads the folder, remote, refs and options of a fetch, and nothing of another command", () => {
		expect(
			gitFetchOf(["-c", "a=b", "-C", "/r", "fetch", "-q", "origin", "main"]),
		).toEqual({
			folder: "/r",
			remote: "origin",
			refspecs: ["main"],
			options: ["-q"],
		});
		expect(gitFetchOf(["-C", "/r", "push", "origin", "main"])).toBeUndefined();
		expect(
			gitFetchOf(["fetch", "origin"]),
			"a fetch in no named folder",
		).toBeUndefined();
	});

	it("takes rules by git folder and reports each one written wrong", () => {
		const parsed = parseWorkFetches({
			fetches: {
				"/w/git/": { through: "turn --", prefetched: true },
				"relative/git": { prefetched: true },
				"/x": { prefetched: "yes" },
				"/y": { through: "" },
			},
		});

		expect(parsed.fetches).toEqual({
			"/w/git": { through: "turn --", prefetched: true },
		});
		expect(parsed.problems).toHaveLength(3);
		expect(parseWorkFetches(undefined)).toEqual({ fetches: {}, problems: [] });
	});
});

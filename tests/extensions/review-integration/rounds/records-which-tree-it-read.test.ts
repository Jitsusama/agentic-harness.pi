/**
 * A round that could not read the change says so where it lasts.
 *
 * Since every round began recording the commit under review, a round
 * that fell back to the caller's checkout has recorded one too. The
 * caveat saying which tree was actually read went only to the session
 * that started the round, and vanished with it. What survived was a
 * ledger entry naming a commit the reviewers were never given.
 *
 * That is not a hypothetical. Two councils fell back because a
 * worktree of that name already existed, and between them returned
 * fifty-nine findings formed against whatever the checkout happened
 * to be at the time:
 *
 *   council-20260804T205254160-000001, 7/7 answered, 11 findings
 *   council-20260805T161139435-000001, 7/7 answered, 48 findings
 *
 * The library half is covered where the answer is composed. This is
 * the other half, and the one that was actually missing: the seam
 * between the tree a round got and the record it leaves. Removing the
 * caveat from that join broke nothing anywhere in the suite, which is
 * how the fault existed in the first place.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	forgetWorkLayer,
	readFrom,
	treeForRound,
	watchForWorkLayer,
} from "../../../../extensions/review-integration/work.ts";
import { runCouncil, startCouncil } from "../../../../lib/core/review/index.ts";
import { OFF } from "../../../../lib/internal/fence/fence-stage.ts";
import { SANDBOX_VARIABLE } from "../../../../lib/internal/sandbox/sandbox.ts";
import { freshRepo } from "../../../support/git-fixture.ts";
import { askSource } from "./ask-source.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "review-config-home-"));
	vi.stubEnv("XDG_CONFIG_HOME", home);
	// Unfenced, whatever runs the tests: inside the fence git is refused in
	// a repo that isn't a cut tree, which these fixtures never are.
	vi.stubEnv(SANDBOX_VARIABLE, OFF);
	forgetWorkLayer();
	// Git is asked for real, through the unattended runner the module
	// uses by default. Without something to ask, nothing can show a
	// directory is a checkout of anything, and every configured path
	// is refused, which would make these cases vacuous.
	watchForWorkLayer({
		events: { on: () => () => {}, emit: () => {} },
	} as unknown as Parameters<typeof watchForWorkLayer>[0]);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
	forgetWorkLayer();
});

/**
 * A real checkout, since the configured path is now verified.
 *
 * Verified by asking git what the directory's remotes are, so a
 * fixture cannot be an empty temp directory: that is exactly what a
 * stale path looks like, and the refusal it produces is correct.
 */
function checkoutOf(named: string): string {
	const path = mkdtempSync(join(tmpdir(), "review-checkout-"));
	execFileSync("git", ["-C", path, "init", "-q"]);
	execFileSync("git", [
		"-C",
		path,
		"remote",
		"add",
		"origin",
		`git@github.com:${named}.git`,
	]);
	return path;
}

/** A checkout of this repo with one commit, and that commit. */
async function checkoutAt(
	named = "Jitsusama/agentic-harness.pi",
): Promise<{ path: string; head: string }> {
	const path = await freshRepo("review-at");
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
	git("remote", "add", "origin", `git@github.com:${named}.git`);
	return { path, head: git("rev-parse", "HEAD") };
}

/** Point the review config's checkout for `match` at `path`. */
function configureCheckout(match: string, path: string): void {
	writeFileSync(
		configPath(),
		JSON.stringify({
			sections: { review: { repos: [{ match, providers: [], path }] } },
		}),
		"utf8",
	);
}

/** The same checkout one commit on, as a tree cut at a PR's head is. */
function movedOn(checkout: { path: string }): { path: string; head: string } {
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", checkout.path, ...args], {
			encoding: "utf8",
		}).trim();
	git(
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"the change under review",
	);
	return { path: checkout.path, head: git("rev-parse", "HEAD") };
}

/** Where the package config lives under the stubbed home. */
function configPath(): string {
	const dir = join(home, "pi", "agentic-harness.pi");
	mkdirSync(dir, { recursive: true });
	return join(dir, "config.json");
}

describe("what a round records about the tree it read", () => {
	it("refuses when nothing knows where the repo under review lives", async () => {
		// Degrading is right when the fallback is the same repository at
		// some other commit, and catastrophic when it is a different
		// repository altogether. Three councils proved which: asked
		// about a change in one repo from a session sitting in another,
		// they read the session's repo and returned 225 findings about
		// code the change does not contain, for $75.63.
		//
		// A repo with neither a checkout nor a remote is exactly that
		// case, because the thing that makes a fallback plausible, that
		// the caller is sitting in the repo under review, is the same
		// thing that would have given it a local path.
		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			"d7205e3c",
			"/the/callers/checkout",
		);

		expect(tree).toEqual({
			refusal: expect.stringContaining("github:elsewhere/other"),
		});
		// And it names the way out that exists, since the refusal is the
		// only place somebody meets this problem.
		if (!("refusal" in tree)) throw new Error("expected a refusal");
		expect(tree.refusal).toContain("review config");
	});

	it("reads a repo the config says where to find", async () => {
		// The other repo problem, and the one that cost a week: a change
		// in a repo this session is not sitting in cannot be reviewed at
		// all. Reading the wrong project was stopped, which turned the
		// silent version into a refusal, and a refusal is still a change
		// nobody reviews. Nothing but a person can say where a repo
		// lives on this machine, so a person says it once in the config.
		const { path: elsewhere, head } = await checkoutAt("elsewhere/other");
		writeFileSync(
			configPath(),
			JSON.stringify({
				sections: {
					review: {
						repos: [
							{ match: "elsewhere/other", providers: [], path: elsewhere },
						],
					},
				},
			}),
			"utf8",
		);

		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			head,
			"/the/callers/checkout",
		);

		// Not a refusal, and standing in the configured checkout rather
		// than in whatever the caller was sitting in.
		if ("refusal" in tree) throw new Error(tree.refusal);
		expect(tree.path).toBe(elsewhere);
	});

	it("reads the checkout the caller named when the configured one is at another commit", async () => {
		// XY9H5C, 21 Nov: a core.nix PR asked about from a tree at its
		// head was refused, naming the configured checkout at main and
		// telling it to name a checkout that has the commit, which is what
		// it had done. The configured path is still the ground for a
		// snapshot; when none can be cut, the named one is tried too.
		const configured = await checkoutAt("elsewhere/other");
		const named = movedOn(await checkoutAt("elsewhere/other"));
		configureCheckout("elsewhere/other", configured.path);
		expect(
			named.head,
			"the two fixtures stand on different commits, or the case proves nothing",
		).not.toBe(configured.head);

		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			named.head,
			named.path,
		);

		if ("refusal" in tree) throw new Error(`refused: ${tree.refusal}`);
		expect(tree, "the named checkout, at the commit, is read").toEqual({
			path: named.path,
		});
	});

	it("refuses naming both checkouts when neither is at the commit", async () => {
		// Trying the named checkout must not turn into reading it anyway,
		// and the refusal says how the named one stands, which is the half
		// of XY9H5C the old message left out.
		const configured = await checkoutAt("elsewhere/other");
		const named = movedOn(await checkoutAt("elsewhere/other"));
		configureCheckout("elsewhere/other", configured.path);

		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			"d7205e3c",
			named.path,
		);

		if (!("refusal" in tree)) throw new Error(`read ${tree.path}`);
		expect(tree.refusal, "the refusal names the commit to fetch").toContain(
			"Fetch d7205e3c",
		);
		expect(
			tree.refusal,
			"the refusal says where the named checkout stands",
		).toContain(`${named.path}, is at ${named.head.slice(0, 12)}`);
		expect(
			tree.refusal,
			"the refusal says where the configured checkout stands",
		).toContain(`${configured.path}, is at ${configured.head.slice(0, 12)}`);
	});

	it("refuses a configured checkout at the commit with changes to its tracked files", async () => {
		// The ground is held to what the named checkout is: a round records
		// the commit it read, so edits on top would be recorded as it.
		const configured = movedOn(await checkoutAt("elsewhere/other"));
		configureCheckout("elsewhere/other", configured.path);
		const tracked = execFileSync("git", ["-C", configured.path, "ls-files"], {
			encoding: "utf8",
		})
			.split("\n")
			.find((line) => line !== "");
		if (tracked === undefined) throw new Error("the fixture tracks no file");
		writeFileSync(join(configured.path, tracked), "edited after the commit\n");

		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			configured.head,
			configured.path,
		);

		if (!("refusal" in tree)) throw new Error(`read ${tree.path}`);
		expect(
			tree.refusal,
			"the refusal names the ground's uncommitted changes",
		).toContain(
			`${configured.path}, is at ${configured.head} with uncommitted changes`,
		);
	});

	it("reads a named checkout at the commit beside untracked scratch", async () => {
		// Untracked files are common in a working checkout and are not in
		// the diff reviewers read, so they do not stop a round.
		const configured = await checkoutAt("elsewhere/other");
		const named = movedOn(await checkoutAt("elsewhere/other"));
		configureCheckout("elsewhere/other", configured.path);
		writeFileSync(join(named.path, "scratch-notes.txt"), "not added\n");

		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			named.head,
			named.path,
		);

		if ("refusal" in tree) throw new Error(`refused: ${tree.refusal}`);
		expect(tree, "untracked scratch leaves the checkout readable").toEqual({
			path: named.path,
		});
	});

	it("refuses a folder inside a checkout at the commit", async () => {
		// A round reads the folder it is given as the repo's root, so a
		// subfolder would be read as the whole commit.
		const configured = await checkoutAt("elsewhere/other");
		const named = movedOn(await checkoutAt("elsewhere/other"));
		configureCheckout("elsewhere/other", configured.path);
		const inside = join(named.path, "ignored-or-not");
		mkdirSync(inside);

		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			named.head,
			inside,
		);

		if (!("refusal" in tree)) throw new Error(`read ${tree.path}`);
		expect(
			tree.refusal,
			"the refusal says it is not the checkout's top",
		).toContain(`${inside}, is a folder inside a checkout`);
	});

	it("refuses a named checkout of another repo, even at the commit", async () => {
		// The commit matching is no evidence of the repo: a checkout of a
		// different project at the same id is still a different project.
		const configured = await checkoutAt("elsewhere/other");
		const stranger = movedOn(await checkoutAt("someone/different"));
		configureCheckout("elsewhere/other", configured.path);

		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			stranger.head,
			stranger.path,
		);

		if (!("refusal" in tree)) throw new Error(`read ${tree.path}`);
		expect(
			tree.refusal,
			"the refusal says the named checkout is another repo",
		).toContain(
			`${stranger.path}, is not a checkout of github:elsewhere/other`,
		);
	});

	it("refuses a named checkout at the commit with changes to its tracked files", async () => {
		// A round records the commit it read, so a tree with edits on top
		// would be recorded as a commit it is not.
		const configured = await checkoutAt("elsewhere/other");
		const named = movedOn(await checkoutAt("elsewhere/other"));
		configureCheckout("elsewhere/other", configured.path);
		const tracked = execFileSync("git", ["-C", named.path, "ls-files"], {
			encoding: "utf8",
		})
			.split("\n")
			.find((line) => line !== "");
		if (tracked === undefined) throw new Error("the fixture tracks no file");
		writeFileSync(join(named.path, tracked), "edited after the commit\n");

		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			named.head,
			named.path,
		);

		if (!("refusal" in tree)) throw new Error(`read ${tree.path}`);
		expect(tree.refusal, "the refusal names the uncommitted changes").toContain(
			"uncommitted changes to tracked files",
		);
	});

	it("refuses a configured path git will not vouch for", async () => {
		// The direction that matters. A mapping matches by substring, so
		// a loose one names a sibling repo, and a path goes stale the day
		// somebody moves a checkout. Trusting it unchecked would put the
		// one failure this whole function exists to prevent behind a
		// config edit, which is worse than not having the field at all.
		const notIt = checkoutOf("someone/different");
		writeFileSync(
			configPath(),
			JSON.stringify({
				sections: {
					review: {
						repos: [{ match: "elsewhere/other", providers: [], path: notIt }],
					},
				},
			}),
			"utf8",
		);

		const tree = await treeForRound(
			{ key: "github:elsewhere/other" },
			"d7205e3c",
			"/the/callers/checkout",
		);

		if (!("refusal" in tree)) throw new Error(`stood in ${tree.path}`);
		// Naming the path it was told about, since the reader's next move
		// is to go and correct it.
		expect(tree.refusal).toContain(notIt);
	});

	it("refuses a checkout that is not at the commit", async () => {
		// The real producer with nothing stubbed: no working layer is
		// loaded in a bare test process, so nobody can cut a snapshot.
		// Reading the checkout anyway, with a caveat, is what two councils
		// did for fifty-nine findings about code that was not the change,
		// so a checkout at another commit is refused with the way out.
		const checkout = await checkoutAt();
		const tree = await treeForRound(
			{ key: "github:Jitsusama/agentic-harness.pi", localPath: checkout.path },
			"d7205e3c",
			"/the/callers/checkout",
		);

		if (!("refusal" in tree)) throw new Error(`read ${tree.path}`);
		expect(tree.refusal).toContain(checkout.head.slice(0, 12));
		expect(tree.refusal).toContain("Fetch d7205e3c");
	});

	it("reads a checkout that is at the commit, with nothing to caveat", async () => {
		// The same state, with the checkout standing on the commit under
		// review: that is the change, so there is nothing to warn about.
		const checkout = await checkoutAt();
		const tree = await treeForRound(
			{ key: "github:Jitsusama/agentic-harness.pi", localPath: checkout.path },
			checkout.head.slice(0, 8),
			"/the/callers/checkout",
		);

		if ("refusal" in tree) throw new Error(`refused: ${tree.refusal}`);
		expect(tree).toEqual({ path: checkout.path });
	});

	it("reads the checkout it knows about, not the one it is sitting in", async () => {
		// When a checkout of the right repo is known, that is where a
		// round without a snapshot belongs. It is the right repo by
		// construction, and the caller's own directory only by luck.
		const checkout = await checkoutAt();
		const tree = await treeForRound(
			{ key: "github:Jitsusama/agentic-harness.pi", localPath: checkout.path },
			checkout.head,
			"/somewhere/else/entirely",
		);

		if ("refusal" in tree) throw new Error(`refused: ${tree.refusal}`);
		expect(tree.path).toBe(checkout.path);
	});

	it("refuses a repo known only by a remote it cannot cut", async () => {
		// The shape the first attempt let straight through. Knowing a
		// remote says where the repo is on the internet, which is no
		// evidence at all about the directory the caller is sitting in,
		// and that directory was the thing about to be reviewed.
		const tree = await treeForRound(
			{
				key: "github:elsewhere/other",
				remoteUrl: "https://github.com/elsewhere/other.git",
			},
			"d7205e3c",
			"/the/callers/checkout",
		);

		expect(tree).toEqual({
			refusal: expect.stringContaining("not a checkout of"),
		});
	});

	it("reaches the run a builder opens, not just the helper", async () => {
		// The helper was tested and the join was not, so the builder a
		// detached round and an interrupted one both go through kept
		// writing the commit alone and nothing said a word. A run that
		// is opened before anybody is asked is the one a later session
		// collects, which is the case this whole change is about.
		const read = readFrom(
			{ path: "/the/callers/checkout", caveat: "read the checkout" },
			"d7205e3c",
		);
		const asking = {
			roster: { reviewers: [{ id: "hawk" }] },
			prompt: "p",
			seq: 1,
			...read,
		};

		// The detached path, which opens a run before anybody answers
		// and writes it to disk. That run is all a later session has.
		const started = await startCouncil(asking, {
			start: async () => {},
			now: () => new Date("2026-08-08T00:00:00.000Z"),
		});
		expect(started.run).toMatchObject({
			witness: "d7205e3c",
			unpinned: "read the checkout",
		});

		// And on the run a finished round hands back, which is a
		// different object built by different code far away from it.
		const { run } = await runCouncil(asking, {
			ask: async () => ({ text: "nothing to report" }),
			now: () => new Date("2026-08-08T00:00:00.000Z"),
			record: async () => [],
		});
		expect(run).toMatchObject({
			witness: "d7205e3c",
			unpinned: "read the checkout",
		});
	});

	it("records the base commit a range round read from, on the run a later session collects", async () => {
		// merge-net counts a range round's read only where its base is on
		// main, and a base named by ref, which means another commit on
		// another machine, counted as none (A2VLJN, 23 November).
		const base = "a".repeat(40);
		const asking = {
			roster: { reviewers: [{ id: "hawk" }] },
			prompt: "p",
			seq: 1,
			...readFrom({ path: "/the/tree" }, "d7205e3c", base),
		};

		const started = await startCouncil(asking, {
			start: async () => {},
			now: () => new Date("2026-08-08T00:00:00.000Z"),
		});
		expect(started.run, "the opened run lost its base").toMatchObject({
			witness: "d7205e3c",
			from: base,
		});
		const { run } = await runCouncil(asking, {
			ask: async () => ({ text: "nothing to report" }),
			now: () => new Date("2026-08-08T00:00:00.000Z"),
			record: async () => [],
		});
		expect(run, "the finished run lost its base").toMatchObject({
			from: base,
		});
		expect(
			readFrom({ path: "/the/tree" }, "d7205e3c"),
			"a round over a change claimed a base",
		).not.toHaveProperty("from");
	});

	it("is passed at every place a round is asked for", () => {
		// The six call sites are the join this file is named for, and
		// three cases against the helper could not see them: the start
		// path passed nothing and the suite stayed green. A scan is a
		// poor test and the right one here, since driving six tools to
		// prove an argument is passed costs more than it tells.
		const source = askSource();

		// Every round this tool can start, by the function it calls.
		const rounds = [
			"runCouncil(",
			"startCouncil(",
			"runJudge(",
			"runCritique(",
			"runAudit(",
		];
		// The canary: a round kind this case has not heard of should
		// fail here rather than be skipped silently.
		expect(
			rounds.flatMap((round) => (source.includes(round) ? [round] : [])),
		).toEqual(rounds);

		// The base travels beside the head, so a range round records the
		// commit it read from wherever it is asked.
		const passes =
			source.split("readFrom(tree, proposal.headCommit, proposal.baseCommit)")
				.length - 1;
		// Six, not five: the retry path asks again and must record what
		// this attempt read, which was the other half of the same fault.
		expect(passes).toBeGreaterThanOrEqual(rounds.length + 1);

		// And that the retry hands it on rather than working it out and
		// dropping it, which is precisely what it did. Making the
		// parameter required stopped the silent omission; it cannot stop
		// a caller passing an empty record, and an empty record is the
		// original bug in a shorter spelling.
		// The outcome carries this attempt's conditions, which are not
		// the round's, so the spread is part of the call this checks.
		expect(source).toContain(
			"substituteOutcome(held, { ...outcome, ...given }, read)",
		);

		// And that every one of them refuses a tree that was refused.
		// The union makes reading a refused tree a compile error, which
		// is most of the guard, but nothing stops a new caller taking
		// the path and never touching it. Counted against the calls
		// rather than fixed at seven, so an eighth round has to answer
		// the question rather than inherit a number.
		const cut = source.split("await treeForRound(").length - 1;
		// A council and a background council make their round in one
		// place, councilRound, which hands its refusal back to each.
		const councils = source.split("await councilRound(").length - 1;
		expect(councils, "both council rounds aren't made in one place").toBe(2);
		const refused = (
			source.match(
				/if \("refusal" in tree\) return (?:\{ refused: )?refuse\(tree\.refusal\)/g,
			) ?? []
		).length;
		// Both sides counted, because equal counts are satisfied by zero
		// and zero: a rename would take the guard and the calls out
		// together and this would go green on a file that no longer
		// contains the thing it polices.
		expect({ cut, refused }).toEqual({
			cut: rounds.length + 2 - (councils - 1),
			refused: cut,
		});
	});

	it("falls back to the checkout the caller named before its own directory", () => {
		// The refusal for a repo nobody knows the checkout of says to run
		// from a checkout, and a session cannot move its own directory.
		// `repo` is the parameter that says where one is, and every round
		// passed the session's directory instead, so naming a checkout
		// was refused with the same words as naming nothing. Scanned for
		// the same reason the case above is: the join is six call sites.
		// Its own directory is the conversation's checkout (`seat.cwd`),
		// not the process's, which a host shares.
		const source = askSource();

		const fallbacks = [
			...source.matchAll(/await treeForRound\(([^;]*?)\);/gs),
		].map((call) => call[1]?.split(",")[2]?.trim());

		// Counted, so a rename that takes the calls out cannot pass on
		// an empty list.
		expect(fallbacks.length).toBeGreaterThan(0);
		expect(new Set(fallbacks)).toEqual(new Set(["params.repo ?? seat.cwd"]));
	});

	it("says nothing about a tree that was the commit", () => {
		// A pinned tree has no caveat, and the record should not invent
		// one: absence is what tells a reader the round was faithful.
		expect(readFrom({ path: "/a/snapshot" }, "d7205e3c")).toEqual({
			witness: "d7205e3c",
		});
	});

	it("still says which tree it read when there was no commit to name", () => {
		// A provider that reports no head commit is ordinary. The round
		// is unpinned for a different reason then, and the reason is
		// the half worth keeping.
		expect(
			readFrom({ path: "/x", caveat: "read /x instead" }, undefined),
		).toEqual({ unpinned: "read /x instead" });
	});
});

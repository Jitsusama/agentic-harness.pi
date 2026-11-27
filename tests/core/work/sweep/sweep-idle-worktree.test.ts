/**
 * Taking back the worktrees a live session left clean, its branch on a
 * remote, out of a real repository, as the snapshot cases in
 * `sweep-idle.test.ts` do. Nothing exists only in such a tree, and its
 * branch stays at its head while the session lives, so asking for it
 * again checks out the same branch and head.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SweepDeps } from "../../../../lib/core/work/sweep.ts";
import { sweepEndedTrees } from "../../../../lib/core/work/sweep.ts";
import { IDLE_WORKTREE_MS } from "../../../../lib/core/work/sweep-idle.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	disposeAll,
	exec,
	machine,
	pinnedWhereNoRefHolds,
	RUNNING,
	setUp,
} from "../support/sweep-live.ts";

afterEach(disposeAll);

/** The session a live tree's record names, which is still open. */
const OPEN_SESSION = "01open-session";

/** Past the worktree idle window by a minute. */
const IDLE = IDLE_WORKTREE_MS + 60_000;

/** An hour, in milliseconds. */
const HOUR = 60 * 60 * 1000;

type Setup = Awaited<ReturnType<typeof setUp>>;

/**
 * A worktree on `branch`, held by {@link RUNNING} for the open session,
 * with a commit pushed to origin's branch of that name, left alone `ago`
 * milliseconds: its record's use, its record file, its folder and its git.
 */
async function pushedAndLeft(
	setup: Setup,
	branch: string,
	ago: number,
): Promise<{ tree: string; commit: string }> {
	const tree = await setup.cut(branch, ["-b", branch, "@", "main"], [RUNNING]);
	await git(tree, "commit", "-q", "--allow-empty", "-m", `work on ${branch}`);
	await git(tree, "push", "-q", "origin", branch);
	const commit = (await git(tree, "rev-parse", "HEAD")).trim();
	await leaveAlone(setup, tree, ago);
	return { tree, commit };
}

/**
 * Date a held tree's record, record file, git and folder `ago` back,
 * its record naming `sessions`.
 */
async function leaveAlone(
	setup: Setup,
	tree: string,
	ago: number,
	sessions: readonly string[] = [OPEN_SESSION],
): Promise<void> {
	const record = setup.memory.recall().find((one) => one.path === tree);
	if (record === undefined) throw new Error(`${tree} has no record`);
	setup.memory.remember({
		...record,
		sessions: [...sessions],
		usedAt: Date.now() - ago,
	});
	const then = new Date(Date.now() - ago);
	const file = join(
		setup.state,
		"cut",
		`${record.identity.key.replaceAll("/", "-")}.json`,
	);
	utimesSync(file, then, then);
	await untouchedFor(tree, ago);
}

/** Date the files a tree's git moves, and its folder, `ago` back. */
async function untouchedFor(tree: string, ago: number): Promise<void> {
	const then = new Date(Date.now() - ago);
	const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
	for (const one of ["HEAD", "index", join("logs", "HEAD")]) {
		utimesSync(join(gitDir, one), then, then);
	}
	utimesSync(tree, then, then);
}

/** Sweep where the open session is live and nothing works in any tree. */
function sweepWhileOpen(
	setup: Setup,
	known: Partial<
		Pick<SweepDeps, "busyAmong" | "claims" | "liveSessions" | "memory">
	> = {},
) {
	return sweepEndedTrees({
		exec,
		memory: setup.memory,
		claims: [],
		lockPath: setup.lockPath,
		facts: machine,
		liveSessions: async () => new Set([OPEN_SESSION]),
		busyAmong: async () => new Set(),
		...known,
	});
}

/** Whether the main checkout still has `branch`, and at what. */
async function branchAt(
	main: string,
	branch: string,
): Promise<string | undefined> {
	try {
		return (
			await git(main, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)
		).trim();
	} catch {
		// git exits 1 for a ref that isn't there.
		return undefined;
	}
}

describe("taking the worktrees a live session left clean and pushed", () => {
	it("takes one an open session left unused a day, its branch on origin, saying whose and why", async () => {
		const setup = await setUp();
		const { tree, commit } = await pushedAndLeft(setup, "left-a-day", IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([
			{
				path: tree,
				branch: "left-a-day",
				sessions: [OPEN_SESSION],
				commit,
				remote: "origin/left-a-day",
				why: "unused for 24 h while its session stayed open, its branch on origin/left-a-day",
			},
		]);
		expect(existsSync(tree), `${tree} is still there`).toBe(false);
		expect(setup.memory.recall().map((one) => one.path)).not.toContain(tree);
		expect(
			await branchAt(setup.main, "left-a-day"),
			"its branch, which asking again checks out",
		).toBe(commit);
	});

	it("takes one its live quest claims until spent and lets idle rules take, keeping the rest it claims", async () => {
		const setup = await setUp();
		const older = await pushedAndLeft(setup, "cut-first", IDLE);
		const newest = await pushedAndLeft(setup, "cut-last", IDLE);

		const outcome = await sweepWhileOpen(setup, {
			claims: {
				held: [],
				untilSpent: [older.tree, newest.tree],
				idleMayTake: [older.tree],
			},
		});

		expect(outcome.taken.map((one) => one.path)).toEqual([older.tree]);
		expect(existsSync(newest.tree), "the quest's newest is kept").toBe(true);
	});

	it("takes none a holder's list lets idle rules take, since a list can't be asked again, in a run that took one it kept", async () => {
		const setup = await setUp();
		const older = await pushedAndLeft(setup, "cut-first", IDLE);
		// The quest's newest, its session ended and trunk holding its branch,
		// which reclaim's rules take before the idle phase.
		const newest = await setup.cut("cut-last", ["-b", "cut-last", "@", "main"]);

		const outcome = await sweepWhileOpen(setup, {
			claims: {
				held: [],
				untilSpent: [older.tree, newest],
				idleMayTake: [older.tree],
			},
		});

		expect(outcome.taken.map((one) => one.path)).toEqual([newest]);
		expect(existsSync(older.tree), "the quest's one tree left").toBe(true);
	});

	it("asks again after taking a tree its holder kept, and keeps what the holder no longer lets go", async () => {
		const setup = await setUp();
		const older = await pushedAndLeft(setup, "cut-first", IDLE);
		const newest = await setup.cut("cut-last", ["-b", "cut-last", "@", "main"]);

		const outcome = await sweepWhileOpen(setup, {
			// As a quest does: an older tree goes only while its newest stands.
			claims: () => ({
				held: [],
				untilSpent: [older.tree, newest],
				idleMayTake: existsSync(newest) ? [older.tree] : [],
			}),
		});

		expect(outcome.taken.map((one) => one.path)).toEqual([newest]);
		expect(existsSync(older.tree), "the quest's one tree left").toBe(true);
	});

	it("asks again before the idle phase, so an older tree stays once its newest went some other way", async () => {
		const setup = await setUp();
		const older = await pushedAndLeft(setup, "cut-first", IDLE);
		const newest = await pushedAndLeft(setup, "cut-last", IDLE);
		let asked = 0;

		const outcome = await sweepWhileOpen(setup, {
			claims: async () => {
				asked += 1;
				const answer = {
					held: [],
					untilSpent: [older.tree, newest.tree],
					idleMayTake: existsSync(newest.tree) ? [older.tree] : [],
				};
				// The quest's own session releases its newest as the run goes,
				// which nothing in the run's outcome records.
				if (asked === 1) {
					await git(setup.main, "worktree", "remove", "--force", newest.tree);
				}
				return answer;
			},
		});

		expect(outcome.taken, "what the run took").toEqual([]);
		expect(existsSync(older.tree), "the quest's one tree left").toBe(true);
	});

	it("takes none a holder kept when asking it again after a kept take fails", async () => {
		const setup = await setUp();
		const older = await pushedAndLeft(setup, "cut-first", IDLE);
		const newest = await setup.cut("cut-last", ["-b", "cut-last", "@", "main"]);
		let asked = 0;

		const outcome = await sweepWhileOpen(setup, {
			// A holder that answers once, then can't, lets nothing more go.
			claims: () => {
				asked += 1;
				if (asked > 1) throw new Error("the quests couldn't be read");
				return {
					held: [],
					untilSpent: [older.tree, newest],
					idleMayTake: [older.tree],
				};
			},
		});

		expect(outcome.taken.map((one) => one.path)).toEqual([newest]);
		expect(existsSync(older.tree), "the quest's one tree left").toBe(true);
	});

	it("still takes an older tree whose newest stands when another quest's kept tree went", async () => {
		const setup = await setUp();
		const older = await pushedAndLeft(setup, "cut-first", IDLE);
		const newest = await pushedAndLeft(setup, "cut-last", IDLE);
		// Another quest's newest, its session ended and trunk holding it.
		const other = await setup.cut("other", ["-b", "other", "@", "main"]);

		const outcome = await sweepWhileOpen(setup, {
			claims: () => ({
				held: [],
				untilSpent: [older.tree, newest.tree, other],
				idleMayTake: existsSync(newest.tree) ? [older.tree] : [],
			}),
		});

		const taken = outcome.taken.map((one) => one.path);
		expect(taken, "what the run took").toEqual([other, older.tree]);
		expect(existsSync(newest.tree), "the quest's newest").toBe(true);
	});

	it("keeps every one its live quest claims until spent when its holder lets idle rules take none", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "claimed", IDLE);

		const outcome = await sweepWhileOpen(setup, {
			claims: { held: [], untilSpent: [tree] },
		});

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("gives the same branch and head back to a session asking for it again", async () => {
		const setup = await setUp();
		const { tree, commit } = await pushedAndLeft(setup, "asked-again", IDLE);
		await sweepWhileOpen(setup);

		// The work tool's cut of a branch that is here (providers/git.ts).
		await git(setup.main, "worktree", "add", "-q", tree, "asked-again");

		expect((await git(tree, "rev-parse", "HEAD")).trim()).toBe(commit);
		expect((await git(tree, "symbolic-ref", "--short", "HEAD")).trim()).toBe(
			"asked-again",
		);
	});

	it("keeps its branch while its session lives though trunk holds it, and lets it go once the session ends", async () => {
		const setup = await setUp();
		const { tree, commit } = await pushedAndLeft(setup, "merged", IDLE);
		await git(setup.main, "merge", "-q", "--ff-only", "merged");
		await git(setup.main, "push", "-q", "origin", "main");
		await git(setup.main, "fetch", "-q", "origin");
		const settled = new Date(Date.now() - 2 * IDLE);
		// The branch drop judges a branch settled by its reflog.
		const log = join(setup.main, ".git", "logs", "refs", "heads", "merged");
		utimesSync(log, settled, settled);
		// A tree a process works in stays held, so every sweep searches this
		// checkout for settled branches, as one on a busy machine does.
		const busy = await pushedAndLeft(setup, "busy", IDLE);
		const working = { busyAmong: async () => new Set([busy.tree]) };

		await sweepWhileOpen(setup, working);
		expect(existsSync(tree), "the tree went").toBe(false);
		await sweepWhileOpen(setup, working);
		expect(
			await branchAt(setup.main, "merged"),
			"its branch, while its session lives",
		).toBe(commit);

		await sweepWhileOpen(setup, {
			...working,
			liveSessions: async () => new Set(),
		});
		expect(
			await branchAt(setup.main, "merged"),
			"its branch, once its session ended",
		).toBeUndefined();
	});

	it("keeps one whose record names no session, which nothing could tell or keep its branch for", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "nobodys", IDLE);
		await leaveAlone(setup, tree, IDLE, []);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `the tree is kept: ${tree}`).toBe(true);
	});

	it("keeps one holding an ignored file, and takes one holding only ignored folders and links", async () => {
		const setup = await setUp();
		const secret = await pushedAndLeft(setup, "secret", IDLE);
		writeFileSync(join(secret.tree, ".gitignore"), ".env\n");
		await git(secret.tree, "add", ".gitignore");
		await git(secret.tree, "commit", "-q", "-m", "ignore .env");
		await git(secret.tree, "push", "-q", "origin", "secret");
		writeFileSync(join(secret.tree, ".env"), "TOKEN=mine\n");
		await leaveAlone(setup, secret.tree, IDLE);
		const built = await pushedAndLeft(setup, "built", IDLE);
		writeFileSync(join(built.tree, ".gitignore"), "node_modules/\nresult\n");
		await git(built.tree, "add", ".gitignore");
		await git(built.tree, "commit", "-q", "-m", "ignore builds");
		await git(built.tree, "push", "-q", "origin", "built");
		mkdirSync(join(built.tree, "node_modules", "left-pad"), {
			recursive: true,
		});
		writeFileSync(join(built.tree, "node_modules", "left-pad", "x.js"), "");
		symlinkSync("/nix/store/made-again", join(built.tree, "result"));
		await leaveAlone(setup, built.tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken.map((one) => one.path)).toEqual([built.tree]);
		expect(existsSync(join(secret.tree, ".env")), "the ignored file").toBe(
			true,
		);
	});

	it("keeps one whose ignored folder no build makes, as a worktree's own .worktrees/", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "nested", IDLE);
		writeFileSync(join(tree, ".gitignore"), ".worktrees/\n");
		await git(tree, "add", ".gitignore");
		await git(tree, "commit", "-q", "-m", "ignore nested trees");
		await git(tree, "push", "-q", "origin", "nested");
		mkdirSync(join(tree, ".worktrees", "spike"), { recursive: true });
		writeFileSync(join(tree, ".worktrees", "spike", "notes.md"), "mine\n");
		await leaveAlone(setup, tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(
			existsSync(join(tree, ".worktrees", "spike", "notes.md")),
			"the worktree's own notes are kept",
		).toBe(true);
	});

	it("keeps one with a file marked skip-worktree, whose edits the status hides", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "hidden", IDLE);
		writeFileSync(join(tree, "local.conf"), "shared\n");
		await git(tree, "add", "local.conf");
		await git(tree, "commit", "-q", "-m", "add a config");
		await git(tree, "push", "-q", "origin", "hidden");
		await git(tree, "update-index", "--skip-worktree", "local.conf");
		writeFileSync(join(tree, "local.conf"), "mine\n");
		await leaveAlone(setup, tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `the tree is kept: ${tree}`).toBe(true);
	});

	it("names its branch whole when a tag shares the name", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "shared-name", IDLE);
		// A tag by its ref, which asks for no signing.
		await git(tree, "update-ref", "refs/tags/shared-name", "HEAD");
		await leaveAlone(setup, tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken.map((one) => one.branch)).toEqual(["shared-name"]);
	});

	it("keeps one whose own HEAD reflog alone holds a commit made there and reset away", async () => {
		const setup = await setUp();
		const { tree, commit } = await pushedAndLeft(setup, "reset", IDLE);
		await git(tree, "commit", "-q", "--allow-empty", "-m", "only here");
		await git(tree, "reset", "-q", "--hard", commit);
		await leaveAlone(setup, tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `the tree is kept: ${tree}`).toBe(true);
	});

	it("keeps one its session switched branch in between the choosing and the take, leaving no note", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "came-back", IDLE);
		let asked = 0;

		const outcome = await sweepWhileOpen(setup, {
			// The choosing asks first; the re-check under the record's lock
			// asks again, as the session switches to a branch at the same
			// head, its git dated back past the choosing's date so only the
			// branch tells.
			busyAmong: async () => {
				asked += 1;
				if (asked === 2) {
					await git(tree, "switch", "-q", "-c", "elsewhere");
					await untouchedFor(tree, IDLE + HOUR);
				}
				return new Set();
			},
		});

		expect(asked, "times the processes were asked").toBe(2);
		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `the tree is kept: ${tree}`).toBe(true);
		expect(
			outcome.kept.find((one) => one.path === tree)?.why,
			"a worktree its session switched branch in was blamed on the reading",
		).toBe("a session took it up again");
		const notes = join(dirname(setup.lockPath), "kept-branches");
		expect(
			existsSync(notes) ? readdirSync(notes) : [],
			"notes left for a tree that stayed",
		).toEqual([]);
	});

	it("keeps one whose reading under its lock can't say, and says so", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "blind", IDLE);
		let asked = 0;

		const outcome = await sweepWhileOpen(setup, {
			// The choosing reads every process; the take's own reading, as
			// when lsof is cut at its limit, can't say.
			busyAmong: async () => {
				asked += 1;
				return asked === 1 ? new Set() : undefined;
			},
		});

		expect(outcome.taken, "a worktree was taken on a blind reading").toEqual(
			[],
		);
		expect(existsSync(tree), "a worktree went on a blind reading").toBe(true);
		expect(
			outcome.kept.find((kept) => kept.path === tree)?.why,
			"a reading that couldn't say was logged as a session taking it up",
		).toBe("the machine can't say which processes hold it");
	});

	it("takes worktrees first with half the share, so a backlog of snapshots never starves them", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "first", IDLE + HOUR);
		await pushedAndLeft(setup, "second", IDLE);
		// An older snapshot, which the snapshots' own turn would take first.
		const snapshot = join(setup.state, "older-snapshot");
		await pinnedWhereNoRefHolds(setup.main, setup.memory, snapshot, [RUNNING]);
		await leaveAlone(setup, snapshot, 2 * IDLE);

		const outcome = await sweepEndedTrees({
			exec,
			memory: setup.memory,
			claims: [],
			lockPath: setup.lockPath,
			facts: machine,
			liveSessions: async () => new Set([OPEN_SESSION]),
			busyAmong: async () => new Set(),
			idleTakes: 2,
		});

		expect(outcome.taken.map((one) => one.path)).toEqual([tree, snapshot]);
		expect(outcome.idleWorktreesLeft, "worktrees left past their half").toBe(1);
	});

	it("keeps one used within the day", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "used-lately", IDLE - HOUR);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `the tree is kept: ${tree}`).toBe(true);
	});

	it("keeps one with a file nobody committed, or a change", async () => {
		const setup = await setUp();
		const untracked = await pushedAndLeft(setup, "untracked", IDLE);
		writeFileSync(join(untracked.tree, "notes"), "mine\n");
		await leaveAlone(setup, untracked.tree, IDLE);
		const changed = await pushedAndLeft(setup, "changed", IDLE);
		writeFileSync(join(changed.tree, ".gitignore"), "changed\n");
		await leaveAlone(setup, changed.tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(
			existsSync(untracked.tree),
			`the tree with an untracked file is kept: ${untracked.tree}`,
		).toBe(true);
		expect(
			existsSync(changed.tree),
			`the tree with a change is kept: ${changed.tree}`,
		).toBe(true);
	});

	it("keeps one whose branch has a stash", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "stashed", IDLE);
		writeFileSync(join(tree, ".gitignore"), "stashed\n");
		await git(tree, "stash", "push", "-q");
		await leaveAlone(setup, tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `the tree is kept: ${tree}`).toBe(true);
	});

	it("keeps one whose last commit is on no remote", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "ahead", IDLE);
		await git(tree, "commit", "-q", "--allow-empty", "-m", "only here");
		await leaveAlone(setup, tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `the tree is kept: ${tree}`).toBe(true);
	});

	it("keeps one a process works in, or one something claims", async () => {
		const setup = await setUp();
		const busy = await pushedAndLeft(setup, "busy", IDLE);
		const claimed = await pushedAndLeft(setup, "claimed", IDLE);

		const outcome = await sweepWhileOpen(setup, {
			busyAmong: async () => new Set([busy.tree]),
			claims: [claimed.tree],
		});

		expect(outcome.taken).toEqual([]);
		expect(existsSync(busy.tree), `the busy tree is kept: ${busy.tree}`).toBe(
			true,
		);
		expect(
			existsSync(claimed.tree),
			`the claimed tree is kept: ${claimed.tree}`,
		).toBe(true);
	});
});

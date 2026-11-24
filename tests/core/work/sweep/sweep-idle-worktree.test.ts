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
		expect(existsSync(tree)).toBe(true);
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

	it("keeps one whose own HEAD reflog alone holds a commit made there and reset away", async () => {
		const setup = await setUp();
		const { tree, commit } = await pushedAndLeft(setup, "reset", IDLE);
		await git(tree, "commit", "-q", "--allow-empty", "-m", "only here");
		await git(tree, "reset", "-q", "--hard", commit);
		await leaveAlone(setup, tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree)).toBe(true);
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
		expect(existsSync(tree)).toBe(true);
		const notes = join(dirname(setup.lockPath), "kept-branches");
		expect(
			existsSync(notes) ? readdirSync(notes) : [],
			"notes left for a tree that stayed",
		).toEqual([]);
	});

	it("takes worktrees first, so a backlog of snapshots never starves them", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "first", IDLE);
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
			idleTakes: 1,
		});

		expect(outcome.taken.map((one) => one.path)).toEqual([tree]);
	});

	it("keeps one used within the day", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "used-lately", IDLE - HOUR);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree)).toBe(true);
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
		expect(existsSync(untracked.tree)).toBe(true);
		expect(existsSync(changed.tree)).toBe(true);
	});

	it("keeps one whose branch has a stash", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "stashed", IDLE);
		writeFileSync(join(tree, ".gitignore"), "stashed\n");
		await git(tree, "stash", "push", "-q");
		await leaveAlone(setup, tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree)).toBe(true);
	});

	it("keeps one whose last commit is on no remote", async () => {
		const setup = await setUp();
		const { tree } = await pushedAndLeft(setup, "ahead", IDLE);
		await git(tree, "commit", "-q", "--allow-empty", "-m", "only here");
		await leaveAlone(setup, tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree)).toBe(true);
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
		expect(existsSync(busy.tree)).toBe(true);
		expect(existsSync(claimed.tree)).toBe(true);
	});
});

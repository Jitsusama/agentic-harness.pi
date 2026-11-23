/**
 * Sweeping ended sessions' trees out of a real repository.
 *
 * The sweep acts, so a fake git answering whatever it was told would
 * prove only that the sweep believes it. These cut real worktrees,
 * write the broker's records for them, and say which sessions still
 * run through stand-in process facts, which ../support/sweep-live.ts
 * sets up.
 */

import {
	chmodSync,
	existsSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import type { TreeProvider } from "../../../../lib/core/work/broker.ts";
import { DEV_SHELL_IDLE_MS } from "../../../../lib/core/work/dev-shell-roots.ts";
import type { createTreeMemory } from "../../../../lib/core/work/memory.ts";
import { sweepEndedTrees } from "../../../../lib/core/work/sweep.ts";
import { guardedExec } from "../../../../lib/internal/sandbox/tree-git.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	disposeAll,
	ENDED,
	elsewhere,
	exec,
	landed,
	machine,
	machineWithUs,
	NO_SUCH_PID,
	pinnedWhereNoRefHolds,
	REST_MS,
	RUNNING,
	SWEEP_TAKES_MS,
	settle,
	settleFolder,
	setUp,
	US_STARTED,
} from "../support/sweep-live.ts";

afterEach(disposeAll);

describe("sweeping the trees whose sessions have ended", () => {
	it("takes an ended session's merged tree, and its branch trunk has", async () => {
		const { main, memory, cut, sweep } = await setUp();
		const tree = await cut("done", ["-b", "done", "@", "main"]);
		// A build the tree made, which git ignores and the removal takes.
		mkdirSync(join(tree, "target"));
		writeFileSync(join(tree, "target", "out"), "built");

		const outcome = await sweep();

		expect(outcome.taken).toEqual([
			{ path: tree, branch: "done", branchGone: true },
		]);
		expect(existsSync(tree), `${tree} is taken`).toBe(false);
		expect(memory.recall().map((one) => one.path)).not.toContain(tree);
		expect(await git(main, "branch", "--list", "done")).toBe("");
		// No snapshot is live, so the idle phase has nothing to judge, and
		// it is still timed.
		expect(
			outcome.idleMs,
			"a run that found nothing idle said how long it looked",
		).toBeGreaterThanOrEqual(0);
	});

	it("takes a detached tree whose commit a ref holds", async () => {
		const { cut, sweep } = await setUp();
		const tree = await cut("snapshot", ["--detach", "@", "main"]);

		expect((await sweep()).taken).toEqual([{ path: tree }]);
	});

	it("takes a clean snapshot at its pin, though no ref holds the commit", async () => {
		const { main, state, memory, sweep } = await setUp();
		const tree = join(state, "pinned");
		await pinnedWhereNoRefHolds(main, memory, tree);
		// A build the snapshot made, which git ignores and the removal takes.
		mkdirSync(join(tree, "target"));
		writeFileSync(join(tree, "target", "out"), "built");

		const outcome = await sweep();

		expect(outcome.taken).toEqual([{ path: tree }]);
		expect(existsSync(tree), `${tree} is taken`).toBe(false);
	});

	it("keeps a snapshot with a new file in it, or moved off its pin", async () => {
		const { main, state, memory, sweep } = await setUp();
		const noted = join(state, "noted");
		await pinnedWhereNoRefHolds(main, memory, noted);
		writeFileSync(join(noted, "notes.txt"), "written here\n");
		const moved = join(state, "moved");
		await pinnedWhereNoRefHolds(main, memory, moved);
		await git(moved, "commit", "-q", "--allow-empty", "-m", "only here");
		// A commit made there and left by checking the pin out again: only
		// that tree's own reflog holds it.
		const left = join(state, "left");
		const pin = await pinnedWhereNoRefHolds(main, memory, left);
		await git(left, "commit", "-q", "--allow-empty", "-m", "tried here");
		await git(left, "checkout", "-q", pin);

		const outcome = await sweep();

		expect(outcome.taken).toEqual([]);
		const why = new Map(outcome.kept.map((one) => [one.path, one.why]));
		expect([...why.keys()].sort()).toEqual([left, moved, noted].sort());
		expect(why.get(noted)).toMatch(/uncommitted changes/);
		expect(why.get(moved)).toMatch(/no branch or tag holds the commit/);
		expect(why.get(left)).toMatch(/no branch or tag holds the commit/);
		expect(existsSync(left), `${left}, with a commit it left, is kept`).toBe(
			true,
		);
		expect(existsSync(noted), `${noted}, with a file of its own, is kept`).toBe(
			true,
		);
		expect(
			existsSync(moved),
			`${moved}, with a commit of its own, is kept`,
		).toBe(true);
	});

	it("keeps a snapshot at its pin that a running session shares", async () => {
		const { main, state, memory, sweep } = await setUp();
		const tree = join(state, "shared");
		await pinnedWhereNoRefHolds(main, memory, tree, [ENDED, RUNNING]);

		expect((await sweep()).taken).toEqual([]);
		expect(
			existsSync(tree),
			`${tree}, which a running session shares, is kept`,
		).toBe(true);
	});

	it("never takes a tree a running session holds, or one claimed", async () => {
		const { cut, sweep } = await setUp();
		const live = await cut(
			"live",
			["-b", "live", "@", "main"],
			[ENDED, RUNNING],
		);
		const claimed = await cut("claimed", ["-b", "claimed", "@", "main"]);

		const outcome = await sweep([claimed]);

		expect(outcome.taken).toEqual([]);
		expect(
			existsSync(live),
			`${live}, which a running session holds, is kept`,
		).toBe(true);
		expect(existsSync(claimed), `${claimed}, which is claimed, is kept`).toBe(
			true,
		);
		expect(outcome.kept.map((one) => one.path)).toEqual([claimed]);
	});

	it("never takes a tree whose record names nobody", async () => {
		const { cut, sweep } = await setUp();
		const unsaid = await cut("unsaid", ["-b", "unsaid", "@", "main"], []);

		expect((await sweep()).taken).toEqual([]);
		expect(
			existsSync(unsaid),
			`${unsaid}, whose record names nobody, is kept`,
		).toBe(true);
	});

	it("takes a squash-landed tree once its HEAD sat a day, naming its remote", async () => {
		const { main, cut, sweep } = await setUp();
		const tree = await landed(cut, "landed");
		await settle(tree);

		const outcome = await sweep();

		expect(outcome.taken).toEqual([
			{ path: tree, branch: "landed", remote: "origin/landed" },
		]);
		expect(existsSync(tree), `${tree} is taken`).toBe(false);
		expect(await git(main, "branch", "--list", "landed")).toContain("landed");
	});

	it("keeps a pushed tree whose HEAD moved within the day", async () => {
		const { cut, sweep } = await setUp();
		const tree = await landed(cut, "fresh");

		const outcome = await sweep();

		expect(outcome.taken).toEqual([]);
		expect(outcome.kept).toEqual([
			{
				path: tree,
				why: "nothing holds it, but fresh is not contained in trunk, so it is either a squash merge or the only copy of that work",
			},
		]);
	});

	it("keeps a tree with a commit on no remote, however long it sat", async () => {
		const { cut, sweep } = await setUp();
		const tree = await landed(cut, "unpushed");
		await git(tree, "commit", "-q", "--allow-empty", "-m", "only here");
		await settle(tree);

		const outcome = await sweep();

		expect(outcome.taken).toEqual([]);
		expect(outcome.kept.map((one) => one.path)).toEqual([tree]);
		expect(
			existsSync(tree),
			`${tree}, with a commit on no remote, is kept`,
		).toBe(true);
	});

	it("keeps a dirty tree and one with work trunk doesn't hold", async () => {
		const { cut, sweep } = await setUp();
		const dirty = await cut("dirty", ["-b", "dirty", "@", "main"]);
		writeFileSync(join(dirty, "notes.txt"), "unsaved\n");
		const ahead = await cut("ahead", ["-b", "ahead", "@", "main"]);
		await git(ahead, "commit", "-q", "--allow-empty", "-m", "work");

		const outcome = await sweep();

		expect(outcome.taken).toEqual([]);
		expect(outcome.kept.map((one) => one.path).sort()).toEqual(
			[ahead, dirty].sort(),
		);
		expect(existsSync(dirty), `${dirty}, which is dirty, is kept`).toBe(true);
		expect(
			existsSync(ahead),
			`${ahead}, which is ahead of trunk, is kept`,
		).toBe(true);
	});

	it("leaves a tree and its record as they were when git refuses", async () => {
		const { main, memory, cut, sweep } = await setUp();
		const locked = await cut("locked", ["-b", "locked", "@", "main"]);
		await git(main, "worktree", "lock", "--reason", "kept\nfor a test", locked);

		const outcome = await sweep();

		// The reason, written by whatever ran there, comes back as one line.
		expect(outcome.refused).toEqual([
			{ path: locked, why: "git has it locked: kept for a test" },
		]);
		expect(existsSync(locked), `${locked}, which git refused, is kept`).toBe(
			true,
		);
		expect(memory.recall().map((one) => one.path)).toContain(locked);
	});

	it("does nothing while another sweep runs, and takes over one that ended", async () => {
		const { lockPath, cut, sweep } = await setUp();
		const tree = await cut("done", ["-b", "done", "@", "main"]);

		writeFileSync(lockPath, String(process.pid));
		const busy = await sweep();
		expect(busy.skipped).toContain(String(process.pid));
		expect(busy.idleMs, "a skipped run timed an idle phase").toBeUndefined();
		expect(existsSync(tree), `${tree} is kept while another sweep runs`).toBe(
			true,
		);

		writeFileSync(lockPath, String(NO_SUCH_PID));
		const after = await sweep();
		expect(after.skipped).toBeUndefined();
		expect(after.taken.map((one) => one.path)).toEqual([tree]);
		expect(
			existsSync(lockPath),
			`${lockPath} is released once the sweep ends`,
		).toBe(false);
	});

	it("rests after any sweep ends, until its rest is over", async () => {
		const { memory, lockPath, cut, elsewhereTree } = await setUp();
		const stamp = `${lockPath}.ended`;
		// The sweep's clock moves on while it runs, as a real sweep takes
		// minutes, through a provider it asks of a tree left a while.
		const started = Date.now();
		let clock = started;
		const slow: TreeProvider = {
			...elsewhere("its provider keeps it"),
			whyKept: async () => {
				clock += SWEEP_TAKES_MS;
				return "its provider keeps it";
			},
		};
		settleFolder(elsewhereTree("slow"));
		const rested = () =>
			sweepEndedTrees({
				exec,
				memory,
				claims: [],
				lockPath,
				facts: machineWithUs,
				providers: () => [slow],
				restMs: REST_MS,
				now: () => clock,
			});

		const first = await rested();
		expect(first.rested, "the first sweep rests").toBeUndefined();
		expect(
			statSync(stamp).mtimeMs,
			"the stamp is dated when the sweep ended, by its own clock",
		).toBeGreaterThanOrEqual(started + SWEEP_TAKES_MS - 1000);
		const ended = statSync(stamp).mtimeMs;
		const tree = await cut("done", ["-b", "done", "@", "main"]);

		clock += REST_MS / 2;
		const soon = await rested();
		expect(soon.rested).toContain("a sweep ended");
		expect(soon.idleMs, "a resting run timed an idle phase").toBeUndefined();
		expect(soon.skipped, "a rest is not a held lock").toBeUndefined();
		expect(existsSync(tree), `${tree} is kept while the sweeps rest`).toBe(
			true,
		);
		expect(statSync(stamp).mtimeMs, "a rest leaves the stamp as it was").toBe(
			ended,
		);

		clock += REST_MS;
		const later = await rested();
		expect(later.rested, "the rest is over").toBeUndefined();
		expect(later.taken.map((one) => one.path)).toEqual([tree]);
	});

	it("rests from nothing when its stamp can't be read", async () => {
		const { memory, lockPath, cut } = await setUp();
		// A stamp that links to itself can't be read, nor written over.
		symlinkSync(`${lockPath}.ended`, `${lockPath}.ended`);
		const tree = await cut("done", ["-b", "done", "@", "main"]);

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath,
			facts: machine,
			restMs: REST_MS,
		});

		expect(outcome.rested).toBeUndefined();
		expect(outcome.taken.map((one) => one.path)).toEqual([tree]);
	});

	it("asks for claims only in a sweep that runs, not one that rests or finds the lock held", async () => {
		// Asking makes each quest sign its whole tree on a host's thread, and
		// sixty first sweeps asking at once held a host past its watchdog on
		// 18 November, though all but one of them rested or skipped.
		const { memory, lockPath } = await setUp();
		let asked = 0;
		const sweep = () =>
			sweepEndedTrees({
				exec,
				memory,
				claims: () => {
					asked++;
					return [];
				},
				lockPath,
				facts: machine,
				restMs: REST_MS,
			});

		const ran = await sweep();
		const rested = await sweep();
		rmSync(`${lockPath}.ended`, { force: true });
		writeFileSync(lockPath, String(process.pid));
		const skipped = await sweep();

		expect(ran.rested ?? ran.skipped, "the first sweep ran").toBeUndefined();
		expect(rested.rested, "the second rested").toContain("a sweep ended");
		expect(skipped.skipped, "the third found the lock held").toContain(
			"another sweep is running",
		);
		expect(asked, "the sweeps that asked for claims").toBe(1);
	});

	it("asks for claims before it reads anything else, so a conversation closing meanwhile has said what its quests hold", async () => {
		const { memory, lockPath } = await setUp();
		const order: string[] = [];
		const watched: typeof memory = {
			...memory,
			recall: () => {
				order.push("recall");
				return memory.recall();
			},
		};

		await sweepEndedTrees({
			exec,
			memory: watched,
			claims: () => {
				order.push("claims");
				return [];
			},
			lockPath,
			facts: machine,
		});

		expect(order[0], "what the sweep asked first").toBe("claims");
	});
});

describe("trees whose repository is gone", () => {
	it("takes one whose clone went with finished work", async () => {
		const { memory, sweep, lostClone } = await setUp();
		const { tree, clone } = await lostClone("lost");

		const outcome = await sweep([], (gitDir) => gitDir.startsWith(clone));

		expect(outcome.taken).toEqual([{ path: tree }]);
		expect(existsSync(tree), `${tree} is taken`).toBe(false);
		expect(memory.recall().map((one) => one.path)).not.toContain(tree);
	});

	it("keeps one whose clone went for any other reason", async () => {
		const { sweep, lostClone } = await setUp();
		const { tree } = await lostClone("lost");

		const outcome = await sweep([], () => false);

		expect(outcome.kept).toEqual([
			{ path: tree, why: "its repository is gone" },
		]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("says only git's entry went when the repository stands", async () => {
		// As `git worktree prune` leaves a tree whose folder it missed.
		const { main, cut, sweep } = await setUp();
		const tree = await cut("pruned", ["--detach", "@", "main"]);
		rmSync(join(main, ".git", "worktrees", "pruned"), { recursive: true });

		const outcome = await sweep([], () => false);

		expect(outcome.kept).toEqual([
			{
				path: tree,
				why: `git's entry for it in ${join(main, ".git")} is gone, though the repository stands`,
			},
		]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});
});

describe("trees whose git pi won't run", () => {
	it("says git was refused there, not that its repository is gone", async () => {
		const { state, memory, lockPath, cut } = await setUp();
		const tree = await cut("unguarded", ["--detach", "@", "main"]);
		// A home holding none of the test's repositories, so the fence guards
		// none of them, and pi's git refuses each tree cut where trees go.
		const home = realpathSync(mkdtempSync(join(tmpdir(), "sweep-home-")));
		try {
			const outcome = await sweepEndedTrees({
				exec: guardedExec(exec, () => ({ home, fenced: false, trees: state })),
				memory,
				claims: [],
				lockPath,
				facts: machine,
			});

			expect(outcome.kept).toEqual([
				{ path: tree, why: "pi won't run git there, so it can't be judged" },
			]);
			expect(existsSync(tree), `${tree} is kept`).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("says a lost clone's repository is gone, though pi's git refuses its tree", async () => {
		// pi's git refuses a tree no worktree names back, as one whose clone
		// went, so only the git folder's absence can say it went.
		const { state, memory, lockPath, lostClone } = await setUp();
		const { tree } = await lostClone("lost");
		const home = realpathSync(mkdtempSync(join(tmpdir(), "sweep-home-")));
		try {
			const outcome = await sweepEndedTrees({
				exec: guardedExec(exec, () => ({ home, fenced: false, trees: state })),
				memory,
				claims: [],
				lockPath,
				facts: machine,
			});

			expect(outcome.kept).toEqual([
				{ path: tree, why: "its repository is gone" },
			]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("trees a session still uses, whatever their owners say", () => {
	/** Name `sessions` on a tree's record, as a broker that knows them does. */
	function heldBy(
		memory: ReturnType<typeof createTreeMemory>,
		path: string,
		sessions: string[],
	): void {
		const record = memory.recall().find((one) => one.path === path);
		if (record !== undefined) memory.remember({ ...record, sessions });
	}

	it("keeps one a running session holds, though its process ended", async () => {
		// A session resumed after a restart runs in a new process; its
		// record still names the old one.
		const { memory, cut, sweepKnowing } = await setUp();
		const tree = await cut("done", ["-b", "done", "@", "main"]);
		heldBy(memory, tree, ["resumed"]);

		const outcome = await sweepKnowing({
			liveSessions: async () => new Set(["resumed"]),
		});

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("takes one whose sessions have all ended too", async () => {
		const { memory, cut, sweepKnowing } = await setUp();
		const tree = await cut("done", ["-b", "done", "@", "main"]);
		heldBy(memory, tree, ["ended"]);

		const outcome = await sweepKnowing({
			liveSessions: async () => new Set(["another"]),
		});

		// The record's sessions are named, so one reopened can recut it.
		expect(outcome.taken).toEqual([
			{ path: tree, branch: "done", branchGone: true, sessions: ["ended"] },
		]);
	});

	it("keeps one a running process stands in", async () => {
		const { cut, sweepKnowing } = await setUp();
		const tree = await cut("done", ["-b", "done", "@", "main"]);
		mkdirSync(join(tree, "deep"));

		const outcome = await sweepKnowing({
			standingIn: () => ["/", join(tree, "deep")],
		});

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("keeps one naming no session whose git moved since the boot", async () => {
		// The record names its process alone, as every record written
		// before sessions were named does, so use since the boot is all
		// that can tell a resumed session is in it.
		const { cut, sweepKnowing } = await setUp();
		const tree = await cut("done", ["-b", "done", "@", "main"]);

		const outcome = await sweepKnowing({ bootedAt: Date.now() - 60_000 });

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("takes one naming no session whose git hasn't moved since", async () => {
		const { cut, sweepKnowing } = await setUp();
		const tree = await cut("done", ["-b", "done", "@", "main"]);

		const outcome = await sweepKnowing({ bootedAt: Date.now() + 60_000 });

		expect(outcome.taken).toEqual([
			{ path: tree, branch: "done", branchGone: true },
		]);
	});
});

describe("trees another provider cut", () => {
	it("takes a spent one through its provider, holding it meanwhile", async () => {
		const { memory, elsewhereTree, sweepWith } = await setUp();
		const tree = elsewhereTree("dev-tree");
		settleFolder(tree);
		let holders: unknown;
		const provider = elsewhere(undefined, async (held) => {
			holders = memory.recall().find((one) => one.path === tree)?.owners;
			rmSync(held.path, { recursive: true, force: true });
		});

		const outcome = await sweepWith(provider);

		expect(holders).toEqual([{ pid: process.pid, startedAt: US_STARTED }]);
		expect(outcome.taken).toEqual([{ path: tree }]);
		expect(existsSync(tree), `${tree} is taken`).toBe(false);
		expect(memory.recall().map((one) => one.path)).not.toContain(tree);
	});

	it("keeps one its provider says to keep", async () => {
		const { elsewhereTree, sweepWith } = await setUp();
		const tree = elsewhereTree("dev-tree");
		settleFolder(tree);

		const outcome = await sweepWith(elsewhere("it has uncommitted changes"));

		expect(outcome.kept).toContainEqual({
			path: tree,
			why: "it has uncommitted changes",
		});
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("keeps a spent one whose HEAD moved within the day, unasked", async () => {
		const { elsewhereCheckout, sweepWith } = await setUp();
		const tree = await elsewhereCheckout("world-tree");
		let asked = false;
		const provider: TreeProvider = {
			...elsewhere(undefined),
			whyKept: async () => {
				asked = true;
				return undefined;
			},
		};

		const outcome = await sweepWith(provider);

		expect(outcome.taken).toEqual([]);
		expect(outcome.kept).toContainEqual({
			path: tree,
			why: "it moved within the last day, so a session may come back to it",
		});
		expect(
			asked,
			"the provider is asked nothing of a tree still settling",
		).toBe(false);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("takes a spent one once its HEAD sat a day", async () => {
		const { elsewhereCheckout, sweepWith } = await setUp();
		const tree = await elsewhereCheckout("world-tree");
		await settle(join(tree, "src"));

		const outcome = await sweepWith(elsewhere(undefined));

		expect(outcome.taken).toEqual([{ path: tree }]);
	});

	it("keeps a spent one with no git that changed within the day", async () => {
		const { elsewhereTree, sweepWith } = await setUp();
		const tree = elsewhereTree("dev-tree");

		const outcome = await sweepWith(elsewhere(undefined));

		expect(outcome.taken).toEqual([]);
		expect(outcome.kept).toContainEqual({
			path: tree,
			why: "it moved within the last day, so a session may come back to it",
		});
	});

	it("keeps a shareable one, which a session could join mid-removal", async () => {
		const { elsewhereTree, sweepWith } = await setUp();
		const tree = elsewhereTree("dev-snapshot", { shareable: true });

		const outcome = await sweepWith(elsewhere(undefined));

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("keeps one a quest claims by the checkout inside it", async () => {
		const { elsewhereTree, sweepWith } = await setUp();
		const tree = elsewhereTree("dev-tree");

		const outcome = await sweepWith(elsewhere(undefined), [join(tree, "src")]);

		expect(outcome.kept).toContainEqual({
			path: tree,
			why: "something still holds it",
		});
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("never takes a running session's", async () => {
		const { elsewhereTree, sweepWith } = await setUp();
		const tree = elsewhereTree("dev-tree", { owners: [RUNNING] });

		const outcome = await sweepWith(elsewhere(undefined));

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("gives the record back to its sessions when the release fails", async () => {
		const { memory, elsewhereTree, sweepWith } = await setUp();
		const tree = elsewhereTree("dev-tree");
		settleFolder(tree);
		const provider = elsewhere(undefined, async () => {
			throw new Error("dev refused");
		});

		const outcome = await sweepWith(provider);

		expect(outcome.refused).toEqual([{ path: tree, why: "dev refused" }]);
		expect(memory.recall().find((one) => one.path === tree)?.owners).toEqual([
			ENDED,
		]);
	});
});

describe("the dev-shell roots of trees nobody entered", () => {
	/** A flake input root nix-direnv left in `tree`, touched `age` ago. */
	function enteredAgo(tree: string, age: number): string {
		const inputs = join(tree, ".direnv", "flake-inputs");
		mkdirSync(inputs, { recursive: true });
		const root = join(inputs, "nixpkgs-source");
		symlinkSync(`/nix/store/${"a".repeat(32)}-source`, root);
		const when = new Date(Date.now() - age);
		lutimesSync(root, when, when);
		return root;
	}

	it("drops them from a held tree once nobody entered it in the window", async () => {
		const { cut, sweep } = await setUp();
		const tree = await cut("live", ["-b", "live", "@", "main"], [RUNNING]);
		const root = enteredAgo(tree, DEV_SHELL_IDLE_MS + 60_000);

		const outcome = await sweep();

		expect(outcome.dropped).toEqual([{ path: tree, roots: 1 }]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
		expect(lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
	});

	it("keeps them in a tree entered inside the window", async () => {
		const { cut, sweep } = await setUp();
		const tree = await cut("live", ["-b", "live", "@", "main"], [RUNNING]);
		const root = enteredAgo(tree, 60_000);

		expect((await sweep()).dropped).toEqual([]);
		const kept = { symlink: lstatSync(root).isSymbolicLink() };
		expect(kept).toEqual({ symlink: true });
	});

	it("keeps them in a tree a running process stands in", async () => {
		// Its shell may be the one direnv loaded, whatever the roots' age.
		const { cut, sweepKnowing } = await setUp();
		const tree = await cut("live", ["-b", "live", "@", "main"], [RUNNING]);
		const root = enteredAgo(tree, DEV_SHELL_IDLE_MS + 60_000);

		const outcome = await sweepKnowing({ standingIn: () => [tree] });

		expect(outcome.dropped).toEqual([]);
		const kept = { symlink: lstatSync(root).isSymbolicLink() };
		expect(kept).toEqual({ symlink: true });
	});
});

describe("taking a tree only while its sessions have all ended", () => {
	it("doesn't run the take for a tree a running session holds", async () => {
		const { cut, memory } = await setUp();
		const tree = await cut("live", ["-b", "live", "@", "main"], [RUNNING]);
		let ran = false;

		const forgotten = await memory.whileUnheld(
			tree,
			async () => {
				ran = true;
				return true;
			},
			machine,
		);

		expect(ran, "the take never ran for a tree a running session holds").toBe(
			false,
		);
		expect(forgotten).toBeUndefined();
		expect(memory.recall().map((one) => one.path)).toContain(tree);
	});
});

describe("taking a tree in a repository of thousands", () => {
	// git's worktree move and remove each read every worktree the repository
	// has: on 22 November, with 2,061 in one, they took 29 s and 19 s a take,
	// so a run took 20 of 1,800 waiting, and each fell further behind.
	it("takes it through pi's guarded git without a git command that reads every worktree", async () => {
		const { main, state, memory, lockPath, cut } = await setUp();
		const tree = await cut("done", ["--detach", "@", "main"]);
		const ran: string[][] = [];
		const watched: Exec = async (command, args) => {
			if (command === "git") ran.push([...args]);
			return await exec(command, args);
		};
		// The outside sweep's git is always guarded, and the guard runs git
		// in a tree only while its git folder names it back, so a take that
		// left that folder naming the old place would be refused every time.
		// Trees are said to be cut elsewhere, so the guard holds these to its
		// back-pointer check alone.
		const home = realpathSync(mkdtempSync(join(tmpdir(), "sweep-home-")));
		const trees = realpathSync(mkdtempSync(join(tmpdir(), "sweep-trees-")));
		try {
			const outcome = await sweepEndedTrees({
				exec: guardedExec(watched, () => ({ home, fenced: false, trees })),
				memory,
				claims: [],
				lockPath,
				facts: machine,
			});

			expect(outcome.refused).toEqual([]);
			expect(outcome.taken.map((one) => one.path)).toEqual([tree]);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(trees, { recursive: true, force: true });
		}
		// The judging phase lists the repository's worktrees once; nothing
		// else may ask git about worktrees, since each such command reads
		// every one.
		const worktreeCommands = ran
			.filter((args) => args.includes("worktree"))
			.map((args) => args[args.indexOf("worktree") + 1]);
		expect(
			worktreeCommands.filter((sub) => sub !== "list"),
			"a take asked git to read every worktree",
		).toEqual([]);
		const listed = await git(main, "worktree", "list", "--porcelain");
		expect(listed, "git still lists the taken tree").not.toContain(tree);
		expect(existsSync(tree), `${tree} is taken`).toBe(false);
		expect(asidesOf(state, tree), "the tree moved aside is gone too").toEqual(
			[],
		);
	});

	it("keeps one whose git folder holds submodules, as git would", async () => {
		const { main, cut, sweep } = await setUp();
		const tree = await cut("modules", ["--detach", "@", "main"]);
		const gitDir = await git(tree, "rev-parse", "--absolute-git-dir");
		mkdirSync(join(gitDir, "modules"));

		const outcome = await sweep();

		expect(outcome.taken).toEqual([]);
		expect(outcome.refused).toEqual([
			{ path: tree, why: "it holds submodules" },
		]);
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
		const listed = await git(main, "worktree", "list", "--porcelain");
		expect(listed, "git still lists the kept tree").toContain(tree);
	});

	it("keeps one with a submodule checked out at a name git would quote", async () => {
		const { main, state, memory, lockPath, cut } = await setUp();
		const tree = await cut("nested", ["--detach", "@", "main"]);
		const commit = await git(main, "rev-parse", "HEAD");
		// A clone of its own checked out inside, added to the index as the
		// take begins, after the sweep judged the tree clean.
		let added = false;
		const nested: Exec = async (command, args) => {
			const take = ["ls-files", "--stage", "-z"].every((arg) =>
				args.includes(arg),
			);
			if (command === "git" && take && !added) {
				added = true;
				const where = args[args.indexOf("-C") + 1] ?? "";
				mkdirSync(join(where, "données"));
				writeFileSync(join(where, "données", ".git"), "gitdir: elsewhere\n");
				await git(
					where,
					"update-index",
					"--add",
					"--cacheinfo",
					`160000,${commit},données`,
				);
			}
			return await exec(command, args);
		};

		const outcome = await sweepEndedTrees({
			exec: nested,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(outcome.refused).toEqual([
			{ path: tree, why: "it holds submodules" },
		]);
		expect(existsSync(join(tree, "données", ".git"))).toBe(true);
		expect(asidesOf(state, tree)).toEqual([]);
	});

	it("keeps one whose .git is a link to another tree's, and that tree's git", async () => {
		const { main, memory, lockPath, cut } = await setUp();
		const ended = await cut("ended", ["--detach", "@", "main"]);
		const live = await cut("live", ["--detach", "@", "main"], [RUNNING]);
		const liveGit = await git(live, "rev-parse", "--absolute-git-dir");
		// Whatever ran in the ended tree pointed its .git at the live one's,
		// whose git folder names that link's target back.
		rmSync(join(ended, ".git"));
		symlinkSync(join(live, ".git"), join(ended, ".git"));

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(outcome.refused).toEqual([
			{ path: ended, why: "it has no plain .git file" },
		]);
		expect(existsSync(liveGit), "the live tree's git folder is kept").toBe(
			true,
		);
		expect(await git(live, "status", "--porcelain")).toBe("");
		expect(
			worktreesOf(await git(main, "worktree", "list", "--porcelain")),
		).toContain(live);
	});

	it("keeps one whose .git names another tree's git folder, and that tree's git", async () => {
		const { main, memory, lockPath, cut } = await setUp();
		const ended = await cut("ended", ["--detach", "@", "main"]);
		const live = await cut("live", ["--detach", "@", "main"], [RUNNING]);
		const liveGit = await git(live, "rev-parse", "--absolute-git-dir");
		// A plain .git file naming the live tree's folder, which names the
		// live tree back, not this one: git reads this tree against the live
		// one's index at the same commit, so it judges clean.
		writeFileSync(join(ended, ".git"), `gitdir: ${liveGit}\n`);

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(outcome.taken.map((one) => one.path)).not.toContain(ended);
		expect(outcome.refused).toEqual([
			{ path: ended, why: `git's folder for it names ${live}` },
		]);
		expect(readFileSync(join(liveGit, "gitdir"), "utf8").trim()).toBe(
			join(live, ".git"),
		);
		expect(await git(live, "status", "--porcelain")).toBe("");
		expect(
			worktreesOf(await git(main, "worktree", "list", "--porcelain")),
		).toContain(live);
	});

	it("keeps one that turned dirty, putting it back as it was", async () => {
		const { main, memory, lockPath, cut } = await setUp();
		const tree = await cut("late", ["--detach", "@", "main"]);
		// A file written as the take begins, after the sweep judged it clean.
		const late: Exec = async (command, args) => {
			if (command === "git" && args.includes("--ignore-submodules=none")) {
				const where = args[args.indexOf("-C") + 1] ?? "";
				writeFileSync(join(where, "notes.txt"), "unsaved\n");
			}
			return await exec(command, args);
		};

		const outcome = await sweepEndedTrees({
			exec: late,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(outcome.taken).toEqual([]);
		expect(outcome.refused).toEqual([
			{ path: tree, why: "it contains modified or untracked files" },
		]);
		expect(readFileSync(join(tree, "notes.txt"), "utf8")).toBe("unsaved\n");
		expect(memory.recall().map((one) => one.path)).toContain(tree);
		// Git's folder names the tree at its own place again, so git lists it
		// there and pi's guarded git still runs in it.
		const gitDir = await git(tree, "rev-parse", "--absolute-git-dir");
		expect(readFileSync(join(gitDir, "gitdir"), "utf8").trim()).toBe(
			join(tree, ".git"),
		);
		expect(
			worktreesOf(await git(main, "worktree", "list", "--porcelain")),
		).toContain(tree);
		expect(await git(tree, "status", "--porcelain")).toContain("notes.txt");
	});

	it("keeps one holding only a new file where the repository hides untracked files", async () => {
		const { main, memory, lockPath, cut } = await setUp();
		await git(main, "config", "status.showUntrackedFiles", "no");
		const tree = await cut("hidden", ["--detach", "@", "main"]);
		const late: Exec = async (command, args) => {
			if (command === "git" && args.includes("--ignore-submodules=none")) {
				const where = args[args.indexOf("-C") + 1] ?? "";
				writeFileSync(join(where, "notes.txt"), "unsaved\n");
			}
			return await exec(command, args);
		};

		const outcome = await sweepEndedTrees({
			exec: late,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(outcome.refused).toEqual([
			{ path: tree, why: "it contains modified or untracked files" },
		]);
		expect(readFileSync(join(tree, "notes.txt"), "utf8")).toBe("unsaved\n");
	});

	it("leaves a tree that turned dirty aside, where git still reads it, when its place was taken", async () => {
		const { state, memory, lockPath, cut } = await setUp();
		const tree = await cut("crowded", ["--detach", "@", "main"]);
		const crowd: Exec = async (command, args) => {
			if (command === "git" && args.includes("--ignore-submodules=none")) {
				const where = args[args.indexOf("-C") + 1] ?? "";
				writeFileSync(join(where, "notes.txt"), "unsaved\n");
				mkdirSync(tree);
				writeFileSync(join(tree, "other"), "something else's\n");
			}
			return await exec(command, args);
		};

		const outcome = await sweepEndedTrees({
			exec: crowd,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		const [aside] = asidesOf(state, tree);
		expect(aside, "the tree is left aside").toBeDefined();
		expect(outcome.refused).toEqual([
			{
				path: tree,
				why: expect.stringMatching(
					/^it contains modified or untracked files; it is left at .*\.going-/,
				),
			},
		]);
		expect(await git(aside ?? "", "status", "--porcelain")).toContain(
			"notes.txt",
		);
	});

	it("reads a tree aside without rewriting the index it is about to remove", async () => {
		const { memory, lockPath, cut } = await setUp();
		const tree = await cut("stale", ["--detach", "@", "main"]);
		// A tracked file whose stat the index no longer matches, so a status
		// that may lock would refresh the index and write it back.
		const later = new Date(Date.now() + 60_000);
		lutimesSync(join(tree, ".gitignore"), later, later);
		const written: boolean[] = [];
		const watched: Exec = async (command, args) => {
			if (command !== "git" || !args.includes("--ignore-submodules=none")) {
				return await exec(command, args);
			}
			const aside = args[args.indexOf("-C") + 1] ?? "";
			const index = join(
				await git(aside, "rev-parse", "--absolute-git-dir"),
				"index",
			);
			// Git writes an index through a lock file it renames into place, so
			// a new inode shows a rewrite where timestamps are too coarse to.
			const stamp = () => {
				const { ino, mtimeNs } = statSync(index, { bigint: true });
				return `${ino}:${mtimeNs}`;
			};
			const before = stamp();
			const result = await exec(command, args);
			written.push(stamp() !== before);
			return result;
		};

		const outcome = await sweepEndedTrees({
			exec: watched,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(outcome.taken.map((one) => one.path)).toEqual([tree]);
		expect(written, "the take's status left the index alone").toEqual([false]);
	});

	it("keeps a tree aside whose tracked file changed under a stale stat", async () => {
		const { memory, lockPath, cut } = await setUp();
		const tree = await cut("edited", ["--detach", "@", "main"]);
		// The same size as what the index holds, and newer, so only reading
		// the file, not its stat, shows git the change.
		const edit: Exec = async (command, args) => {
			if (command === "git" && args.includes("--ignore-submodules=none")) {
				const where = args[args.indexOf("-C") + 1] ?? "";
				writeFileSync(join(where, ".gitignore"), "output/\n");
				const later = new Date(Date.now() + 60_000);
				lutimesSync(join(where, ".gitignore"), later, later);
			}
			return await exec(command, args);
		};

		const outcome = await sweepEndedTrees({
			exec: edit,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(outcome.refused).toEqual([
			{ path: tree, why: "it contains modified or untracked files" },
		]);
		expect(readFileSync(join(tree, ".gitignore"), "utf8")).toBe("output/\n");
	});

	it("leaves a tree cut at the same place mid-take its own git folder", async () => {
		const { main, memory, lockPath, cut } = await setUp();
		const tree = await cut("again", ["--detach", "@", "main"]);
		// A session asks for the same snapshot while the old one is aside.
		const recut: Exec = async (command, args) => {
			if (command === "git" && args.includes("--ignore-submodules=none")) {
				await git(main, "worktree", "add", "-q", "--detach", tree, "main");
			}
			return await exec(command, args);
		};

		const outcome = await sweepEndedTrees({
			exec: recut,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(outcome.taken.map((one) => one.path)).toEqual([tree]);
		const gitDir = await git(tree, "rev-parse", "--absolute-git-dir");
		expect(existsSync(join(gitDir, "HEAD")), "the new tree's git folder").toBe(
			true,
		);
		expect(await git(tree, "status", "--porcelain")).toBe("");
		const listed = await git(main, "worktree", "list", "--porcelain");
		expect(listed).toContain(tree);
	});

	// Root removes what a folder's mode refuses, so the git folder would go.
	it.skipIf(process.getuid?.() === 0)(
		"says a git folder that won't go stays, and goes on to the next tree",
		async () => {
			const { memory, lockPath, cut, state } = await setUp();
			const stuck = await cut("stuck", ["--detach", "@", "main"]);
			const next = await cut("next", ["--detach", "@", "main"]);
			const gitDir = await git(stuck, "rev-parse", "--absolute-git-dir");
			const readOnly = join(gitDir, "held");
			mkdirSync(join(readOnly, "deep"), { recursive: true });
			writeFileSync(join(readOnly, "deep", "file"), "kept\n");
			chmodSync(readOnly, 0o500);
			try {
				const outcome = await sweepEndedTrees({
					exec,
					memory,
					claims: [],
					lockPath,
					facts: machine,
				});

				expect(outcome.taken.map((one) => one.path)).toEqual([next]);
				expect(outcome.refused).toEqual([
					{
						path: stuck,
						why: expect.stringMatching(/^its git folder .* stays: /),
					},
				]);
				expect(existsSync(stuck), `${stuck}'s files are gone`).toBe(false);
				expect(asidesOf(state, stuck), `${stuck}'s aside is gone`).toEqual([]);
			} finally {
				chmodSync(readOnly, 0o700);
			}
		},
	);
});

/** The worktrees `git worktree list --porcelain` names, each whole. */
function worktreesOf(listed: string): string[] {
	return listed
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

/** What of `tree` is left moved aside beside it. */
function asidesOf(state: string, tree: string): string[] {
	return readdirSync(state)
		.filter((name) => name.startsWith(`${basename(tree)}.going-`))
		.map((name) => join(state, name));
}

describe("a tree whose record another process holds locked past the wait", () => {
	// On 22 November one record's lock, held past 10 s on a loaded machine,
	// failed the outside sweep's whole run 40 minutes in, logging nothing it
	// took.
	const held = "its record's lock has been held for over 10s";

	/** `real`, but another process holds `locked`'s record past the wait. */
	function lockedFor(
		real: ReturnType<typeof createTreeMemory>,
		locked: string,
	): ReturnType<typeof createTreeMemory> {
		const memory: typeof real = Object.create(real);
		const refuse = (path: string) => {
			// Coded as file-lock's own throw is, which its test pins.
			if (path === locked) {
				throw Object.assign(new Error(held), { code: "ELOCKHELD" });
			}
		};
		memory.whileUnheld = async (path, take, facts) => {
			refuse(path);
			return await real.whileUnheld(path, take, facts);
		};
		memory.holdWhileUnheld = async (path, facts) => {
			refuse(path);
			return await real.holdWhileUnheld(path, facts);
		};
		return memory;
	}

	it("keeps that ended tree and takes the others", async () => {
		const { memory, lockPath, cut } = await setUp();
		const first = await cut("first", ["--detach", "@", "main"]);
		const middle = await cut("middle", ["--detach", "@", "main"]);
		const last = await cut("last", ["--detach", "@", "main"]);

		const outcome = await sweepEndedTrees({
			exec,
			memory: lockedFor(memory, middle),
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(outcome.taken.map((one) => one.path).sort()).toEqual(
			[first, last].sort(),
		);
		expect(outcome.kept, "the one it couldn't lock").toContainEqual({
			path: middle,
			why: held,
		});
		expect(outcome.refused).toEqual([]);
		expect(existsSync(middle), `${middle} is kept`).toBe(true);
		expect(memory.recall().map((one) => one.path)).toContain(middle);
	});

	it("keeps that tree a quest claims until spent", async () => {
		const { memory, lockPath, cut } = await setUp();
		const claimed = await cut("claimed", ["--detach", "@", "main"]);

		const outcome = await sweepEndedTrees({
			exec,
			memory: lockedFor(memory, claimed),
			claims: { held: [], untilSpent: [claimed] },
			lockPath,
			facts: machine,
		});

		expect(outcome.kept).toContainEqual({ path: claimed, why: held });
		expect(existsSync(claimed), `${claimed} is kept`).toBe(true);
		expect(memory.recall().map((one) => one.path)).toContain(claimed);
	});

	it("keeps that tree of a clone gone with finished work", async () => {
		const { memory, lockPath, lostClone } = await setUp();
		const { tree, clone } = await lostClone("lost");

		const outcome = await sweepEndedTrees({
			exec,
			memory: lockedFor(memory, tree),
			claims: [],
			lockPath,
			facts: machine,
			wentWithFinishedWork: (gitDir) => gitDir.startsWith(clone),
		});

		expect(outcome.kept).toContainEqual({ path: tree, why: held });
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});

	it("keeps that tree of another provider", async () => {
		const { memory, lockPath, elsewhereTree } = await setUp();
		const tree = elsewhereTree("dev-tree");
		settleFolder(tree);
		const provider = elsewhere(undefined, async (spent) => {
			rmSync(spent.path, { recursive: true, force: true });
		});

		const outcome = await sweepEndedTrees({
			exec,
			memory: lockedFor(memory, tree),
			claims: [],
			lockPath,
			facts: machineWithUs,
			providers: () => [provider],
		});

		expect(outcome.kept).toContainEqual({ path: tree, why: held });
		expect(existsSync(tree), `${tree} is kept`).toBe(true);
	});
});

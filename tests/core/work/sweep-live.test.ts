/**
 * Sweeping ended sessions' trees out of a real repository.
 *
 * The sweep acts, so a fake git answering whatever it was told would
 * prove only that the sweep believes it. These cut real worktrees,
 * write the broker's records for them, and say which sessions still
 * run through stand-in process facts.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Owner, ProcessFacts } from "../../../lib/core/process/index.ts";
import type { HeldTree, TreeProvider } from "../../../lib/core/work/broker.ts";
import { DEV_SHELL_IDLE_MS } from "../../../lib/core/work/dev-shell-roots.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import type { SweepDeps } from "../../../lib/core/work/sweep.ts";
import {
	PUSHED_SETTLE_MS,
	sweepEndedTrees,
} from "../../../lib/core/work/sweep.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

/** An exec over real processes, shaped the way the library expects. */
const exec = (command: string, args: readonly string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
		execFile(command, [...args], (error, stdout, stderr) =>
			done({
				code:
					error === null ? 0 : typeof error.code === "number" ? error.code : 1,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			}),
		),
	);

/** The pid of a session that has ended, and one still running. */
const ENDED = { pid: 4001, startedAt: 1000 };
const RUNNING = { pid: 4002, startedAt: 2000 };

/** A machine where only {@link RUNNING} runs. */
const machine: ProcessFacts = {
	alive: (pid) => pid === RUNNING.pid,
	startedAt: async (pid) =>
		pid === RUNNING.pid ? RUNNING.startedAt : undefined,
};

/** When this test's own process started, as {@link machineWithUs} says. */
const US_STARTED = 3000;

/** {@link machine}, where this test's own process runs too. */
const machineWithUs: ProcessFacts = {
	alive: (pid) => pid === RUNNING.pid || pid === process.pid,
	startedAt: async (pid) =>
		pid === RUNNING.pid
			? RUNNING.startedAt
			: pid === process.pid
				? US_STARTED
				: undefined,
};

/** The id of a provider other than git's. */
const ELSEWHERE = "elsewhere";

/**
 * A provider other than git's, saying `why` it keeps a tree and
 * releasing one with `release`, which removes the folder unless told
 * otherwise.
 */
function elsewhere(
	why: string | undefined,
	release: (held: HeldTree) => Promise<void> = async (held) =>
		rmSync(held.path, { recursive: true, force: true }),
): TreeProvider {
	return {
		id: ELSEWHERE,
		specificity: 0,
		appliesTo: () => false,
		ensure: async () => {
			throw new Error("the sweep never cuts a tree");
		},
		release,
		whyKept: async () => why,
	};
}

/** A pid no process can have, for a lock whose holder has ended. */
const NO_SUCH_PID = 2_147_483_646;

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) disposeRepo(dir);
	dirs = [];
});

/** A repository with a remote, a records folder and a trees folder. */
async function setUp() {
	const remote = await freshRepo("sweep-remote");
	const main = await freshRepo("sweep-main");
	const state = realpathSync(mkdtempSync(join(tmpdir(), "sweep-state-")));
	dirs.push(remote, main, state);
	writeFileSync(join(main, ".gitignore"), "target/\n");
	await git(main, "add", ".gitignore");
	await git(main, "commit", "-qm", "ignore builds");
	await git(remote, "config", "receive.denyCurrentBranch", "ignore");
	await git(main, "remote", "add", "origin", remote);
	await git(main, "push", "-q", "origin", "main");
	await git(main, "fetch", "-q", "origin");
	const memory = createTreeMemory(join(state, "cut"));
	const lockPath = join(state, "sweep.lock");

	/** Cut a worktree and write the broker's record of it. */
	async function cut(
		key: string,
		how: string[],
		owners: readonly Owner[] = [ENDED],
	): Promise<string> {
		const path = join(state, key);
		// `@` in the arguments stands for the tree's own path.
		const args = how.map((arg) => (arg === "@" ? path : arg));
		await git(main, "worktree", "add", "-q", ...args);
		memory.remember({
			identity: { key, shareable: false },
			path,
			providerId: "git-worktree",
			...(owners.length > 0 ? { owners: [...owners] } : {}),
		});
		return path;
	}

	const sweep = (
		claims: readonly string[] = [],
		wentWithFinishedWork?: (gitDir: string) => boolean,
	) =>
		sweepEndedTrees({
			exec,
			memory,
			claims,
			lockPath,
			facts: machine,
			...(wentWithFinishedWork ? { wentWithFinishedWork } : {}),
		});

	/** A snapshot cut from a clone that is then deleted, as conclude does. */
	async function lostClone(
		key: string,
	): Promise<{ tree: string; clone: string }> {
		const clone = await freshRepo("sweep-clone");
		dirs.push(clone);
		const tree = join(state, key);
		await git(clone, "worktree", "add", "-q", "--detach", tree, "main");
		memory.remember({
			identity: { key, shareable: true },
			path: tree,
			providerId: "git-worktree",
			owners: [ENDED],
		});
		disposeRepo(clone);
		return { tree, clone };
	}

	/** A tree another provider cut: a folder, and the broker's record. */
	function elsewhereTree(
		key: string,
		how: { shareable?: boolean; owners?: readonly Owner[] } = {},
	): string {
		const path = join(state, key);
		mkdirSync(join(path, "src"), { recursive: true });
		writeFileSync(join(path, "src", "file"), "committed\n");
		memory.remember({
			identity: { key, shareable: how.shareable ?? false },
			path,
			providerId: ELSEWHERE,
			owners: [...(how.owners ?? [ENDED])],
		});
		return path;
	}

	/**
	 * A tree another provider cut whose checkout is git's, as World's
	 * keeps its checkout in `src`: a worktree of trunk, and the record.
	 */
	async function elsewhereCheckout(key: string): Promise<string> {
		const path = join(state, key);
		mkdirSync(path, { recursive: true });
		await git(
			main,
			"worktree",
			"add",
			"-q",
			"--detach",
			join(path, "src"),
			"main",
		);
		memory.remember({
			identity: { key, shareable: false },
			path,
			providerId: ELSEWHERE,
			owners: [ENDED],
		});
		return path;
	}

	/** Sweep with `provider` loaded, on a machine where this test runs. */
	const sweepWith = (provider: TreeProvider, claims: readonly string[] = []) =>
		sweepEndedTrees({
			exec,
			memory,
			claims,
			lockPath,
			facts: machineWithUs,
			providers: () => [provider],
		});

	return {
		main,
		memory,
		lockPath,
		cut,
		sweep,
		lostClone,
		elsewhereTree,
		elsewhereCheckout,
		sweepWith,
		sweepKnowing,
	};

	/** Sweep, told what `known` says of the sessions and processes now. */
	function sweepKnowing(
		known: Pick<SweepDeps, "liveSessions" | "standingIn" | "bootedAt">,
	) {
		return sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath,
			facts: machine,
			...known,
		});
	}
}

/**
 * Cut a tree on `branch` with a commit trunk doesn't hold and push it,
 * as a branch a squash merge landed is left.
 */
async function landed(
	cut: (key: string, how: string[]) => Promise<string>,
	branch: string,
): Promise<string> {
	const tree = await cut(branch, ["-b", branch, "@", "main"]);
	await git(tree, "commit", "-q", "--allow-empty", "-m", "work");
	await git(tree, "push", "-q", "origin", branch);
	return tree;
}

/** Put a folder with no git, and its `src`, two days back, as one left alone. */
function settleFolder(tree: string): void {
	const then = new Date(Date.now() - 2 * PUSHED_SETTLE_MS);
	for (const one of [join(tree, "src", "file"), join(tree, "src"), tree]) {
		utimesSync(one, then, then);
	}
}

/** Put a tree's HEAD and its reflog two days back, as one left alone. */
async function settle(tree: string): Promise<void> {
	const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
	const then = new Date(Date.now() - 2 * PUSHED_SETTLE_MS);
	for (const one of ["HEAD", join("logs", "HEAD")]) {
		utimesSync(join(gitDir, one), then, then);
	}
}

describe("sweeping the trees whose sessions have ended", () => {
	it("takes an ended session's merged tree, keeping its branch", async () => {
		const { main, memory, cut, sweep } = await setUp();
		const tree = await cut("done", ["-b", "done", "@", "main"]);
		// A build the tree made, which git ignores and the removal takes.
		mkdirSync(join(tree, "target"));
		writeFileSync(join(tree, "target", "out"), "built");

		const outcome = await sweep();

		expect(outcome.taken).toEqual([{ path: tree, branch: "done" }]);
		expect(existsSync(tree), `${tree} is taken`).toBe(false);
		expect(memory.recall().map((one) => one.path)).not.toContain(tree);
		expect(await git(main, "branch", "--list", "done")).toContain("done");
	});

	it("takes a detached tree whose commit a ref holds", async () => {
		const { cut, sweep } = await setUp();
		const tree = await cut("snapshot", ["--detach", "@", "main"]);

		expect((await sweep()).taken).toEqual([{ path: tree }]);
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
		await git(main, "worktree", "lock", locked);

		const outcome = await sweep();

		expect(outcome.refused.map((one) => one.path)).toEqual([locked]);
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
			{ path: tree, branch: "done", sessions: ["ended"] },
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

		expect(outcome.taken).toEqual([{ path: tree, branch: "done" }]);
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

/**
 * What the sweep's live tests stand on: a real repository with a remote,
 * the broker's records for trees cut from it, and stand-in process facts
 * saying which sessions still run.
 */

import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Owner,
	ProcessFacts,
} from "../../../../lib/core/process/index.ts";
import type {
	HeldTree,
	TreeProvider,
} from "../../../../lib/core/work/broker.ts";
import {
	createTreeMemory,
	type TreeMemory,
} from "../../../../lib/core/work/memory.ts";
import type {
	SweepClaims,
	SweepDeps,
} from "../../../../lib/core/work/sweep.ts";
import {
	PUSHED_SETTLE_MS,
	sweepEndedTrees,
} from "../../../../lib/core/work/sweep.ts";
import { treeIdentity } from "../../../../lib/core/work/tree.ts";
import { disposeRepo, freshRepo, git } from "../../../support/git-fixture.ts";

/** An exec over real processes, shaped the way the library expects. */
export const exec = (command: string, args: readonly string[]) =>
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
export const ENDED = { pid: 4001, startedAt: 1000 };
export const RUNNING = { pid: 4002, startedAt: 2000 };

/** A machine where only {@link RUNNING} runs. */
export const machine: ProcessFacts = {
	alive: (pid) => pid === RUNNING.pid,
	startedAt: async (pid) =>
		pid === RUNNING.pid ? RUNNING.startedAt : undefined,
};

/** When this test's own process started, as {@link machineWithUs} says. */
export const US_STARTED = 3000;

/** {@link machine}, where this test's own process runs too. */
export const machineWithUs: ProcessFacts = {
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
export function elsewhere(
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

/** How long the sweeps rest in the test of resting. */
export const REST_MS = 20 * 60 * 1000;

/** How long a sweep takes in the test of resting, by its own clock. */
export const SWEEP_TAKES_MS = 5 * 60 * 1000;

/** A pid no process can have, for a lock whose holder has ended. */
export const NO_SUCH_PID = 2_147_483_646;

let dirs: string[] = [];

/** Remove every repository and folder {@link setUp} made, after each case. */
export function disposeAll(): void {
	for (const dir of dirs) disposeRepo(dir);
	dirs = [];
}

/** A repository with a remote, a records folder and a trees folder. */
export async function setUp() {
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
		claims: SweepClaims = [],
		wentWithFinishedWork?: (gitDir: string) => boolean,
		signs: Pick<
			SweepDeps,
			| "sessionFolders"
			| "busyAmong"
			| "mergedHeads"
			| "lockWaitMs"
			| "lockWaitEveryMs"
			| "betweenIdleTakes"
		> = {},
	) =>
		sweepEndedTrees({
			exec,
			memory,
			claims,
			lockPath,
			facts: machine,
			...(wentWithFinishedWork ? { wentWithFinishedWork } : {}),
			...signs,
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
		state,
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
export async function landed(
	cut: (key: string, how: string[]) => Promise<string>,
	branch: string,
): Promise<string> {
	const tree = await cut(branch, ["-b", branch, "@", "main"]);
	await git(tree, "commit", "-q", "--allow-empty", "-m", "work");
	await git(tree, "push", "-q", "origin", branch);
	return tree;
}

/**
 * Cut a snapshot at a commit no ref holds, as a pull request's head is
 * left once its branch is pushed again over it, with the broker's record
 * of a snapshot pinned there.
 */
export async function pinnedWhereNoRefHolds(
	main: string,
	memory: TreeMemory,
	path: string,
	owners: readonly Owner[] = [ENDED],
): Promise<string> {
	await git(main, "branch", "-q", "before-rebase", "main");
	await git(main, "checkout", "-q", "before-rebase");
	// A message of its own, so two snapshots cut in one second differ.
	await git(main, "commit", "-q", "--allow-empty", "-m", `head of ${path}`);
	const commit = (await git(main, "rev-parse", "HEAD")).trim();
	await git(main, "checkout", "-q", "main");
	await git(main, "branch", "-q", "-D", "before-rebase");
	await git(main, "worktree", "add", "-q", "--detach", path, commit);
	// The identity the broker gives a snapshot, so the pin is read back
	// from the key it really writes.
	memory.remember({
		identity: treeIdentity({
			intent: "snapshot",
			repo: { key: "local:repo" },
			purpose: "review",
			commit,
		}),
		path,
		providerId: "git-worktree",
		owners: [...owners],
	});
	return commit;
}

/** Put a folder with no git, and its `src`, two days back, as one left alone. */
export function settleFolder(tree: string): void {
	const then = new Date(Date.now() - 2 * PUSHED_SETTLE_MS);
	for (const one of [join(tree, "src", "file"), join(tree, "src"), tree]) {
		utimesSync(one, then, then);
	}
}

/** Put a tree's HEAD and its reflog two days back, as one left alone. */
export async function settle(tree: string): Promise<void> {
	const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
	const then = new Date(Date.now() - 2 * PUSHED_SETTLE_MS);
	for (const one of ["HEAD", join("logs", "HEAD")]) {
		utimesSync(join(gitDir, one), then, then);
	}
}

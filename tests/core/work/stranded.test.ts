/**
 * The trees standing where the broker cuts them that nothing can use,
 * against real folders and, where a cut is the claim, real git.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../lib/core/exec/index.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import { createGitTreeProvider } from "../../../lib/core/work/providers/git.ts";
import {
	CANT_SAY,
	CUT_GRACE_MS,
	cutRunning,
	LOCK_STALE_MS,
	plainWords,
	type StrandedRecords,
	setAside,
	splitStranded,
	strandedDir,
	strandedTrees,
	WORKED_IN,
} from "../../../lib/core/work/stranded.ts";
import { type TreeRequest, treeIdentity } from "../../../lib/core/work/tree.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

/** What the guard says of a tree whose repository it doesn't guard. */
const REFUSED = "it is a worktree of a repository the fence doesn't guard.";

let root = "";
let trees = "";
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "stranded-")));
	trees = join(root, "work", "trees");
	mkdirSync(trees, { recursive: true });
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A worktree's folder whose `.git` file names `gitDir`. */
function treeNaming(name: string, gitDir: string): string {
	const path = join(trees, name);
	mkdirSync(path);
	writeFileSync(join(path, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(path, "notes.md"), "written by a reader\n");
	return path;
}

/** A git folder that is there, as a standing repository's would be. */
function standingGitDir(name: string): string {
	const gitDir = join(root, "elsewhere", ".git", "worktrees", name);
	mkdirSync(gitDir, { recursive: true });
	return gitDir;
}

describe("strandedTrees", () => {
	it("names a tree nothing holds that git is refused in, with the refusal", () => {
		const path = treeNaming("snapshot-a", standingGitDir("snapshot-a"));

		expect(
			strandedTrees({ dir: trees, kept: new Set(), refusal: () => REFUSED }),
		).toEqual([{ path, why: REFUSED }]);
	});

	it("names a tree whose git folder is gone, without the path it names", () => {
		// The path in a `.git` file is anybody's to write, so it isn't said.
		const gone = join(root, "deleted-clone", ".git", "worktrees", "b");
		const path = treeNaming("snapshot-b", gone);

		expect(
			strandedTrees({ dir: trees, kept: new Set(), refusal: () => undefined }),
		).toEqual([{ path, why: "the git folder its .git file names is gone" }]);
	});

	it("leaves out a tree git reads", () => {
		treeNaming("snapshot-c", standingGitDir("snapshot-c"));

		expect(
			strandedTrees({ dir: trees, kept: new Set(), refusal: () => undefined }),
		).toEqual([]);
	});

	it("leaves out a tree something holds, whatever git says of it", () => {
		// Held by its real path, and listed through a link to the trees'
		// folder, so only a listing that resolves links matches the two.
		const path = treeNaming("snapshot-d", standingGitDir("snapshot-d"));
		const linked = join(root, "linked-trees");
		symlinkSync(trees, linked);

		expect(
			strandedTrees({
				dir: linked,
				kept: new Set([path]),
				refusal: () => REFUSED,
			}),
		).toEqual([]);
	});

	it("says what git said as one plain line, cut short when long", () => {
		const path = treeNaming("snapshot-h", standingGitDir("snapshot-h"));
		const forged = `fatal: nope\n\u001b[2Jinjected ${"x".repeat(500)}`;

		const [found] = strandedTrees({
			dir: trees,
			kept: new Set(),
			refusal: () => forged,
		});

		expect(found?.path).toBe(path);
		expect(found?.why).toBe(plainWords(forged));
		expect(found?.why).toMatch(/^fatal: nope \[2Jinjected x+\.\.\.$/);
		expect(found?.why.length).toBe(203);
	});

	it("says back no mark that moves a reader's cursor or turns text", () => {
		// A C1 escape, a bidi override and a line separator, each of which
		// some terminal or reader acts on.
		const said = plainWords("a\u009b2Jb\u202ec\u2028d\u2066e");

		expect(said).toBe("a 2Jb c d e");
	});

	it("leaves out what is no worktree, and what the sweep is removing", () => {
		mkdirSync(join(trees, "no-git-here"));
		writeFileSync(join(trees, "check.log"), "a log beside the trees\n");
		treeNaming("snapshot-e.going-0a1b2c3d", standingGitDir("snapshot-e"));

		expect(
			strandedTrees({ dir: trees, kept: new Set(), refusal: () => REFUSED }),
		).toEqual([]);
	});

	it("finds none where no tree was ever cut", () => {
		expect(
			strandedTrees({
				dir: join(root, "never-made"),
				kept: new Set(),
				refusal: () => REFUSED,
			}),
		).toEqual([]);
	});
});

describe("splitStranded", () => {
	/** A stranded tree whose `.git` was written `ageMs` ago. */
	function aged(name: string, ageMs: number): string {
		const path = treeNaming(name, standingGitDir(name));
		const at = (Date.now() - ageMs) / 1000;
		utimesSync(join(path, ".git"), at, at);
		return path;
	}
	const LONG_AGO = 2 * CUT_GRACE_MS;
	const nobody = async () => new Set<string>();

	it("frees a tree nothing makes or works in", async () => {
		const path = aged("snapshot-i", LONG_AGO);

		const split = await splitStranded([{ path, why: REFUSED }], {
			busyAmong: nobody,
		});

		expect(split).toEqual({ free: [{ path, why: REFUSED }], kept: [] });
	});

	it("keeps a tree a process works in, saying so", async () => {
		// Listed through a link, while the machine names the real path, as
		// the kernel does, so only a split that resolves links keeps it.
		const path = aged("snapshot-j", LONG_AGO);
		const linked = join(root, "linked-trees");
		symlinkSync(trees, linked);
		const listed = join(linked, "snapshot-j");

		const split = await splitStranded([{ path: listed, why: REFUSED }], {
			busyAmong: async () => new Set([path]),
		});

		expect(split).toEqual({
			free: [],
			kept: [{ path: listed, why: WORKED_IN }],
		});
	});

	it("frees a tree its machine names no process in", async () => {
		const path = aged("snapshot-q", LONG_AGO);
		const other = aged("snapshot-r", LONG_AGO);

		const split = await splitStranded(
			[
				{ path, why: REFUSED },
				{ path: other, why: REFUSED },
			],
			{ busyAmong: async () => new Set([other]) },
		);

		expect(split).toEqual({
			free: [{ path, why: REFUSED }],
			kept: [{ path: other, why: WORKED_IN }],
		});
	});

	it("keeps every tree where the machine can't say what works in it", async () => {
		const path = aged("snapshot-k", LONG_AGO);

		const split = await splitStranded([{ path, why: REFUSED }], {});

		expect(split).toEqual({ free: [], kept: [{ path, why: CANT_SAY }] });
	});

	it("keeps a tree git marks locked, as it does while a cut runs", async () => {
		const gitDir = standingGitDir("snapshot-l");
		const path = treeNaming("snapshot-l", gitDir);
		const at = (Date.now() - LONG_AGO) / 1000;
		utimesSync(join(path, ".git"), at, at);
		writeFileSync(join(gitDir, "locked"), "initializing\n");

		const split = await splitStranded([{ path, why: REFUSED }], {
			busyAmong: nobody,
		});

		expect(split.free).toEqual([]);
		expect(split.kept[0]?.why).toMatch(/git marks it locked/);
	});

	it("frees a tree whose lock a killed cut left long ago", async () => {
		// A cut killed outright never takes its lock away, and a lock read
		// as running for ever would keep the tree for ever.
		const gitDir = standingGitDir("snapshot-s");
		const path = treeNaming("snapshot-s", gitDir);
		const at = (Date.now() - 2 * LOCK_STALE_MS) / 1000;
		utimesSync(join(path, ".git"), at, at);
		writeFileSync(join(gitDir, "locked"), "initializing\n");
		utimesSync(join(gitDir, "locked"), at, at);

		const split = await splitStranded([{ path, why: REFUSED }], {
			busyAmong: nobody,
		});

		expect(cutRunning(path), "the lock is long past").toBe(false);
		expect(split).toEqual({ free: [{ path, why: REFUSED }], kept: [] });
	});

	it("keeps a tree cut lately, whose record may not be written yet", async () => {
		const path = aged("snapshot-m", CUT_GRACE_MS / 2);

		const split = await splitStranded([{ path, why: REFUSED }], {
			busyAmong: nobody,
		});

		expect(split.free).toEqual([]);
		expect(split.kept[0]?.why).toMatch(/cut in the last ten minutes/);
	});
});

/** Records naming `recorded`, whose lock lets a take run when `spent`. */
function recordsOf(recorded: string, spent: boolean) {
	const asked: string[] = [];
	const records: StrandedRecords = {
		recall: () => [{ path: recorded }],
		whileUnheld: async (path, take) => {
			asked.push(path);
			return spent && (await take()) ? { path } : undefined;
		},
	};
	return { records, asked };
}

describe("setAside", () => {
	it("moves each tree whole beside the trees' folder, freeing its name", async () => {
		const path = treeNaming("snapshot-f", standingGitDir("snapshot-f"));
		const into = strandedDir(trees);

		const [moved] = await setAside([{ path, why: REFUSED }], { into });

		expect(into).toBe(join(dirname(trees), "stranded"));
		expect(moved?.kind).toBe("set-aside");
		const aside = moved?.kind === "set-aside" ? moved.aside : "";
		expect(dirname(aside)).toBe(into);
		expect(existsSync(path), "its name is free to cut again").toBe(false);
		expect(
			readFileSync(join(aside, "notes.md"), "utf8"),
			"every file it held goes with it",
		).toBe("written by a reader\n");
		expect(
			existsSync(join(aside, ".git")),
			"it no longer names git's entry",
		).toBe(false);
		expect(readFileSync(join(aside, ".git-was"), "utf8")).toContain("gitdir:");
	});

	it("says a tree another reclaim took as it was asked about is gone", async () => {
		const path = treeNaming("snapshot-raced", standingGitDir("snapshot-raced"));
		const records: StrandedRecords = {
			recall: () => [{ path }],
			whileUnheld: async (_at, take) => {
				// The other reclaim moves it in the moment before this one.
				rmSync(path, { recursive: true, force: true });
				return (await take()) ? {} : undefined;
			},
		};

		const [raced] = await setAside([{ path, why: REFUSED }], {
			into: strandedDir(trees),
			records,
		});

		expect(raced?.kind).toBe("gone");
	});

	it("says a tree went before its turn and goes on with the rest", async () => {
		// Another reclaim or the sweep may take one first.
		const missing = join(trees, "snapshot-gone-already");
		const path = treeNaming("snapshot-g", standingGitDir("snapshot-g"));

		const done = await setAside(
			[
				{ path: missing, why: REFUSED },
				{ path, why: REFUSED },
			],
			{ into: strandedDir(trees) },
		);

		expect(done.map((one) => one.kind)).toEqual(["gone", "set-aside"]);
	});

	it("says why a move was refused, leaving the tree where it was", async () => {
		const path = treeNaming("snapshot-n", standingGitDir("snapshot-n"));
		const into = strandedDir(trees);
		writeFileSync(into, "a file where the folder would go\n");

		const [done] = await setAside([{ path, why: REFUSED }], { into });

		expect(done?.kind).toBe("refused");
		expect(done?.kind === "refused" ? done.why : "").toMatch(/EEXIST|ENOTDIR/);
		expect(existsSync(path), "it stays where it was").toBe(true);
	});

	it("moves a recorded tree under its record's lock once its holders end", async () => {
		const path = treeNaming("snapshot-o", standingGitDir("snapshot-o"));
		const { records, asked } = recordsOf(path, true);

		const [moved] = await setAside([{ path, why: REFUSED }], {
			into: strandedDir(trees),
			records,
		});

		expect(asked, "asked under the record's lock").toEqual([path]);
		expect(moved?.kind).toBe("set-aside");
		expect(existsSync(path), "its name is free to cut again").toBe(false);
	});

	it("keeps a recorded tree a session may still hold", async () => {
		const path = treeNaming("snapshot-p", standingGitDir("snapshot-p"));
		const { records } = recordsOf(path, false);

		const [kept] = await setAside([{ path, why: REFUSED }], {
			into: strandedDir(trees),
			records,
		});

		expect(kept?.kind).toBe("kept");
		expect(kept?.kind === "kept" ? kept.why : "").toMatch(/may still hold/);
		expect(existsSync(path), "it stays where it was").toBe(true);
	});

	it("sets aside a tree the broker recorded for a session that ended", async () => {
		// The broker's own records, not a stand-in, so the lock and the
		// forgetting are the ones reclaim really takes.
		const path = treeNaming("snapshot-t", standingGitDir("snapshot-t"));
		const memory = createTreeMemory(join(root, "work", "cut"));
		memory.remember({
			identity: { key: "snapshot-t", shareable: true },
			path,
			providerId: "git",
			// Above the system's highest pid, so nothing can be wearing it.
			owners: [{ pid: 0x7f_ff_ff_ff, startedAt: 1 }],
		});

		const [moved] = await setAside([{ path, why: REFUSED }], {
			into: strandedDir(trees),
			records: memory,
		});

		expect(moved?.kind).toBe("set-aside");
		expect(existsSync(path), "its name is free to cut again").toBe(false);
		expect(
			memory.recall().map((one) => one.path),
			"its record went with it",
		).toEqual([]);
	});

	it("keeps a tree the broker recorded for nobody it can name", async () => {
		// A record from before owners were written: nothing can say its
		// holder ended, so the tree stays.
		const path = treeNaming("snapshot-u", standingGitDir("snapshot-u"));
		const memory = createTreeMemory(join(root, "work", "cut"));
		memory.remember({
			identity: { key: "snapshot-u", shareable: true },
			path,
			providerId: "git",
		});

		const [kept] = await setAside([{ path, why: REFUSED }], {
			into: strandedDir(trees),
			records: memory,
		});

		expect(kept?.kind).toBe("kept");
		expect(existsSync(path), "it stays where it was").toBe(true);
	});
});

describe("a snapshot at a stranded tree's commit", () => {
	let source = "";
	let clone = "";
	afterEach(() => {
		disposeRepo(source);
		disposeRepo(clone);
	});

	/** Real git, but refused in `refusedIn` as the fence's guard refuses it. */
	function guarded(refusedIn: string): Exec {
		return (command, args) =>
			new Promise((done) => {
				if (args[0] === "-C" && args[1] === refusedIn) {
					done({ code: 126, stdout: "", stderr: REFUSED });
					return;
				}
				execFile(command, [...args], (error, stdout, stderr) =>
					done({
						code:
							error === null
								? 0
								: typeof error.code === "number"
									? error.code
									: 1,
						stdout: stdout ?? "",
						stderr: stderr ?? "",
					}),
				);
			});
	}

	it("is cut once the stranded tree is set aside", async () => {
		source = await freshRepo("stranded-source");
		clone = await freshRepo("stranded-clone");
		const commit = await git(source, "rev-parse", "HEAD");
		const request: TreeRequest = {
			intent: "snapshot",
			repo: { key: "github:o/r", localPath: source },
			purpose: "review",
			commit,
		};
		const path = join(trees, treeIdentity(request).key);
		// Cut from another clone, as a council's snapshot was, which this
		// checkout's git doesn't list and the guard won't run git in.
		await git(clone, "worktree", "add", "--detach", path, commit);
		const provider = createGitTreeProvider({
			exec: guarded(path),
			stateDir: trees,
			subvolumes: async () => false,
		});
		await expect(provider.ensure(request)).rejects.toThrow(
			"which git here won't read",
		);

		const stranded = strandedTrees({
			dir: trees,
			kept: new Set(),
			refusal: (at) => (at === path ? REFUSED : undefined),
		});
		expect(stranded.map((one) => one.path)).toEqual([path]);
		await setAside(stranded, { into: strandedDir(trees) });

		await expect(provider.ensure(request)).resolves.toEqual({ path });
		expect(await git(path, "rev-parse", "HEAD")).toBe(commit);
	});

	it("is cut again from the very clone that cut the stranded tree", async () => {
		// That clone still lists the tree it cut, by a folder now gone,
		// and git refuses the name until the entry is pruned.
		clone = await freshRepo("stranded-same-clone");
		const commit = await git(clone, "rev-parse", "HEAD");
		const request: TreeRequest = {
			intent: "snapshot",
			repo: { key: "github:o/r", localPath: clone },
			purpose: "review",
			commit,
		};
		const path = join(trees, treeIdentity(request).key);
		await git(clone, "worktree", "add", "--detach", path, commit);
		const provider = createGitTreeProvider({
			exec: guarded(path),
			stateDir: trees,
			subvolumes: async () => false,
		});
		// Another tree that clone cut, gone by other means, whose entry
		// is git's own prune's to forget rather than this cut's.
		const other = join(trees, "snapshot-other");
		await git(clone, "worktree", "add", "--detach", other, commit);
		rmSync(other, { recursive: true, force: true });
		await setAside([{ path, why: REFUSED }], { into: strandedDir(trees) });

		await expect(provider.ensure(request)).resolves.toEqual({ path });
		expect(await git(path, "rev-parse", "HEAD")).toBe(commit);
		expect(
			await git(clone, "worktree", "list", "--porcelain"),
			"the other gone tree's entry stays",
		).toContain("snapshot-other");
	});

	it("is cut again whatever language git refuses the name in", async () => {
		const cut = await killedCut(LOCK_STALE_MS + 60_000);
		await setAside([{ path: cut.path, why: REFUSED }], {
			into: strandedDir(trees),
		});
		const inEnglish = guarded(cut.path);
		// As a git in another language says it: none of git's English.
		const elsewhere: Exec = async (command, args) => {
			const ran = await inEnglish(command, args);
			return args.includes("add") && ran.code !== 0
				? { ...ran, stderr: "fatal: «arbre déjà inscrit»\n" }
				: ran;
		};
		const provider = createGitTreeProvider({
			exec: elsewhere,
			stateDir: trees,
			subvolumes: async () => false,
		});

		await expect(provider.ensure(cut.request)).resolves.toEqual({
			path: cut.path,
		});
	});

	it("is cut again into the empty folder a subvolume makes first", async () => {
		// Where each tree is a subvolume, the cut makes it at the tree's
		// name before git runs, so git's gone entry meets an empty folder.
		const cut = await killedCut(LOCK_STALE_MS + 60_000);
		await setAside([{ path: cut.path, why: REFUSED }], {
			into: strandedDir(trees),
		});
		mkdirSync(cut.path);

		await expect(cut.provider.ensure(cut.request)).resolves.toEqual({
			path: cut.path,
		});
		expect(await git(cut.path, "rev-parse", "HEAD")).toBe(cut.commit);
	});

	/**
	 * Cut a snapshot from one clone, killed as git marked it locked, or
	 * locked by hand for `reason`.
	 */
	async function killedCut(lockedAgo: number, reason = "initializing") {
		clone = await freshRepo("stranded-locked-clone");
		const commit = await git(clone, "rev-parse", "HEAD");
		const request: TreeRequest = {
			intent: "snapshot",
			repo: { key: "github:o/r", localPath: clone },
			purpose: "review",
			commit,
		};
		const path = join(trees, treeIdentity(request).key);
		await git(clone, "worktree", "add", "--detach", path, commit);
		const entry = join(clone, ".git", "worktrees", treeIdentity(request).key);
		const lock = join(entry, "locked");
		writeFileSync(lock, `${reason}\n`);
		const at = new Date(Date.now() - lockedAgo);
		utimesSync(lock, at, at);
		const provider = createGitTreeProvider({
			exec: guarded(path),
			stateDir: trees,
			subvolumes: async () => false,
		});
		return { commit, entry, path, provider, request };
	}

	it("is cut again where a killed cut's lock is an hour old", async () => {
		// git won't forget a locked entry, and reclaim sets aside a tree
		// whose lock is this old, so the cut has to forget it itself.
		const cut = await killedCut(LOCK_STALE_MS + 60_000);
		await setAside([{ path: cut.path, why: REFUSED }], {
			into: strandedDir(trees),
		});

		await expect(cut.provider.ensure(cut.request)).resolves.toEqual({
			path: cut.path,
		});
		expect(await git(cut.path, "rev-parse", "HEAD")).toBe(cut.commit);
	});

	it("leaves a lock put there by hand alone, however old", async () => {
		const cut = await killedCut(LOCK_STALE_MS + 60_000, "on a drive away");
		rmSync(cut.path, { recursive: true, force: true });

		await expect(cut.provider.ensure(cut.request)).rejects.toThrow(
			"missing but locked worktree",
		);
		expect(existsSync(join(cut.entry, "locked")), "git's entry stays").toBe(
			true,
		);
	});

	it("leaves a fresh lock alone, as its cut may still be running", async () => {
		const cut = await killedCut(60_000);
		rmSync(cut.path, { recursive: true, force: true });

		await expect(cut.provider.ensure(cut.request)).rejects.toThrow(
			"missing but locked worktree",
		);
		expect(existsSync(join(cut.entry, "locked")), "git's entry stays").toBe(
			true,
		);
	});
});

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
import { createGitTreeProvider } from "../../../lib/core/work/providers/git.ts";
import {
	CANT_SAY,
	CUT_GRACE_MS,
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

	it("names a tree whose git folder is gone, saying which", () => {
		const gone = join(root, "deleted-clone", ".git", "worktrees", "b");
		const path = treeNaming("snapshot-b", gone);

		expect(
			strandedTrees({ dir: trees, kept: new Set(), refusal: () => undefined }),
		).toEqual([
			{ path, why: `the git folder its .git names, ${gone}, is gone` },
		]);
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
		expect(found?.why.length).toBe(403);
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
		const path = aged("snapshot-j", LONG_AGO);

		const split = await splitStranded([{ path, why: REFUSED }], {
			busyAmong: async (paths) => new Set(paths),
		});

		expect(split).toEqual({ free: [], kept: [{ path, why: WORKED_IN }] });
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
	});

	it("says why a move was refused and goes on with the rest", async () => {
		const missing = join(trees, "snapshot-gone-already");
		const path = treeNaming("snapshot-g", standingGitDir("snapshot-g"));

		const done = await setAside(
			[
				{ path: missing, why: REFUSED },
				{ path, why: REFUSED },
			],
			{ into: strandedDir(trees) },
		);

		expect(done.map((one) => one.kind)).toEqual(["refused", "set-aside"]);
		expect(done[0]?.kind === "refused" ? done[0].why : "").toMatch(/ENOENT/);
	});

	it("keeps a tree asked about again that must stay after all", async () => {
		const path = treeNaming("snapshot-n", standingGitDir("snapshot-n"));

		const done = await setAside([{ path, why: REFUSED }], {
			into: strandedDir(trees),
			stays: async () => WORKED_IN,
		});

		expect(done).toEqual([{ kind: "kept", path, why: WORKED_IN }]);
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
});

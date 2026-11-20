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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../lib/core/exec/index.ts";
import { createGitTreeProvider } from "../../../lib/core/work/providers/git.ts";
import {
	setAside,
	strandedDir,
	strandedTrees,
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
		).toEqual([{ path, why: `the git folder its .git names, ${gone}, is gone` }]);
	});

	it("leaves out a tree git reads, which ensure hands over as it stands", () => {
		treeNaming("snapshot-c", standingGitDir("snapshot-c"));

		expect(
			strandedTrees({ dir: trees, kept: new Set(), refusal: () => undefined }),
		).toEqual([]);
	});

	it("leaves out a tree something holds, whatever git says of it", () => {
		const path = treeNaming("snapshot-d", standingGitDir("snapshot-d"));

		expect(
			strandedTrees({
				dir: trees,
				kept: new Set([path]),
				refusal: () => REFUSED,
			}),
		).toEqual([]);
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

describe("setAside", () => {
	it("moves each tree whole beside the trees' folder, freeing its name", () => {
		const path = treeNaming("snapshot-f", standingGitDir("snapshot-f"));
		const into = strandedDir(trees);

		const [moved] = setAside([{ path, why: REFUSED }], into);

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

	it("says why a move was refused and goes on with the rest", () => {
		const missing = join(trees, "snapshot-gone-already");
		const path = treeNaming("snapshot-g", standingGitDir("snapshot-g"));

		const done = setAside(
			[
				{ path: missing, why: REFUSED },
				{ path, why: REFUSED },
			],
			strandedDir(trees),
		);

		expect(done.map((one) => one.kind)).toEqual(["refused", "set-aside"]);
		expect(done[0]?.kind === "refused" ? done[0].why : "").toMatch(/ENOENT/);
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
		setAside(stranded, strandedDir(trees));

		await expect(provider.ensure(request)).resolves.toEqual({ path });
		expect(await git(path, "rev-parse", "HEAD")).toBe(commit);
	});
});

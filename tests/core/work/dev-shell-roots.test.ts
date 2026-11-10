/**
 * The Nix roots a tree's dev shell leaves, and dropping them once
 * nobody has entered the tree for a while.
 *
 * Real folders and links, since the module reads and removes them: a
 * root is a symlink, and its age is the link's own time, which only a
 * real filesystem keeps. The store paths the links name don't exist,
 * as a link is read without being followed.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEV_SHELL_IDLE_MS,
	devShellRoots,
	dropIdleDevShellRoots,
	rootsReport,
} from "../../../lib/core/work/dev-shell-roots.ts";
import { createGitTreeProvider } from "../../../lib/core/work/providers/git.ts";
import { treeIdentity } from "../../../lib/core/work/tree.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

const DAY = 24 * 60 * 60 * 1000;

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function folder(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dev-shell-roots-")));
	dirs.push(dir);
	return dir;
}

/** A link named `at` to a store path, last touched `age` ago. */
function root(at: string, age = 0): void {
	symlinkSync(`/nix/store/${"a".repeat(32)}-${at.split("/").pop()}`, at);
	const when = new Date(Date.now() - age);
	lutimesSync(at, when, when);
}

/** A tree as nix-direnv leaves it after an entry `age` ago. */
function enteredTree(tree: string, age = 0): void {
	const layout = join(tree, ".direnv");
	mkdirSync(join(layout, "flake-inputs"), { recursive: true });
	mkdirSync(join(layout, "bin"));
	root(join(layout, "flake-inputs", "nixpkgs-source"), age);
	root(join(layout, "flake-inputs", "core-source"), age);
	root(join(layout, "flake-profile-abc123"), age);
	writeFileSync(join(layout, "flake-profile-abc123.rc"), "export PATH=x\n");
}

describe("the roots a tree holds", () => {
	it("finds nix-direnv's roots and the result links, and when they were touched", () => {
		const tree = folder();
		enteredTree(tree, 2 * DAY);
		root(join(tree, "result"), 5 * DAY);
		root(join(tree, "result-2"), DAY);
		// A link that names no store path is somebody's own, not a root.
		symlinkSync("/etc/hostname", join(tree, "result-mine"));

		const found = devShellRoots(tree);

		const inside = found.roots.map((one) => one.slice(tree.length + 1));
		expect(inside.sort()).toEqual([
			".direnv/flake-inputs/core-source",
			".direnv/flake-inputs/nixpkgs-source",
			".direnv/flake-profile-abc123",
			"result",
			"result-2",
		]);
		// The newest, since nix-direnv touches every root it keeps on
		// each entry: the tree was last used when its last root was.
		expect(Date.now() - (found.lastTouched ?? 0)).toBeLessThan(DAY + 60_000);
	});

	it("finds none in a tree no dev shell was entered in", () => {
		expect(devShellRoots(folder())).toEqual({ roots: [] });
	});
});

describe("dropping the roots of a tree nobody entered", () => {
	it("drops them all once every root is older than the idle window", () => {
		const tree = folder();
		enteredTree(tree, DEV_SHELL_IDLE_MS + DAY);
		root(join(tree, "result"), DEV_SHELL_IDLE_MS + DAY);

		const dropped = dropIdleDevShellRoots(tree, Date.now());

		expect(dropped).toBe(4);
		expect(devShellRoots(tree).roots).toEqual([]);
		// The profile's .rc goes with its root, so the next entry builds
		// the shell afresh rather than loading one whose paths are gone.
		expect(readdirSync(join(tree, ".direnv")).sort()).toEqual(["bin"]);
		expect(existsSync(join(tree, "result")), "result link goes").toBe(false);
	});

	it("keeps every root while any was touched inside the window", () => {
		const tree = folder();
		enteredTree(tree, DEV_SHELL_IDLE_MS + DAY);
		root(join(tree, "result"), DAY);

		expect(dropIdleDevShellRoots(tree, Date.now())).toBe(0);
		expect(devShellRoots(tree).roots).toHaveLength(4);
	});

	it("does nothing to a tree with no roots", () => {
		expect(dropIdleDevShellRoots(folder(), Date.now())).toBe(0);
	});
});

describe("saying which trees hold roots", () => {
	it("lists them most roots first, marking those the sweep drops", () => {
		const now = Date.now();
		const lines = rootsReport(
			[
				{ path: "/t/few", roots: 2, lastTouched: now - DAY },
				{ path: "/t/many", roots: 36, lastTouched: now - 5 * DAY },
				{ path: "/t/none", roots: 0 },
			],
			now,
		);

		expect(lines).toEqual([
			"2 trees here hold 38 Nix roots; 1 not entered in 3 days loses them at the next sweep.",
			"   /t/many: 36 roots, entered 5 days ago, dropped at the next sweep",
			"   /t/few: 2 roots, entered 1 day ago",
		]);
	});

	it("says nothing when no tree holds a root", () => {
		const none = [{ path: "/t/none", roots: 0 }];
		expect(rootsReport(none, Date.now())).toEqual([]);
	});
});

describe("releasing a tree", () => {
	it("takes its dev shell's roots with it, which git ignores", async () => {
		const main = await freshRepo("dev-shell-release");
		const state = folder();
		try {
			writeFileSync(join(main, ".gitignore"), ".direnv/\nresult*\n");
			await git(main, "add", ".gitignore");
			await git(main, "commit", "-qm", "ignore the dev shell");
			const exec = (command: string, args: readonly string[]) =>
				new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
					execFile(command, [...args], (error, stdout, stderr) =>
						done({
							code:
								error === null
									? 0
									: typeof error.code === "number"
										? error.code
										: 1,
							stdout,
							stderr,
						}),
					),
				);
			const provider = createGitTreeProvider({ exec, stateDir: state });
			const request = {
				intent: "worktree" as const,
				repo: { key: "local:dev-shell", localPath: main },
				purpose: "roots",
				branch: "roots",
			};
			const { path } = await provider.ensure(request);
			enteredTree(path);
			root(join(path, "result"));

			await provider.release({
				identity: treeIdentity(request),
				path,
				providerId: provider.id,
			});

			expect(existsSync(path), `${path} is released`).toBe(false);
		} finally {
			disposeRepo(main);
		}
	});
});

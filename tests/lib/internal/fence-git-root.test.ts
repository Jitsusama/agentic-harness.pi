/**
 * The watch that guards a worktree's shared git folder while fenced
 * commands may write it: a planted name gone at once, its sessions
 * logged and stopped, a folder it can't guard left read-only, and the
 * after-check that keeps a command's status.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fenceArgs } from "../../../lib/internal/fence.ts";
import type { Disk } from "../../../lib/internal/fence-disk.ts";
import {
	afterCheck,
	armSharedRoot,
	disarmAll,
	endFencedCommands,
	guardedIn,
	guardedNames,
	plantStopped,
	ROOT_KEPT,
	sharedGitFolder,
	sharedRootArgs,
	sharedRootFor,
} from "../../../lib/internal/fence-git-root.ts";

/** How soon a planted name must be gone (ISXEG8). */
const PROMPTLY_MS = 100;

let base: string;
let root: string;
let own: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "fence-git-root-")));
	root = join(base, "repo", ".git");
	own = join(root, "worktrees", "tree");
	mkdirSync(own, { recursive: true });
	writeFileSync(join(root, "config"), "[core]\n\tbare = false\n");
});

afterEach(() => {
	disarmAll();
	rmSync(base, { recursive: true, force: true });
});

/** Stand-ins for what a plant sets off, recording each session. */
function watched() {
	return { refused: vi.fn<(session: string) => void>(), stop: vi.fn() };
}

describe("which git folder a worktree shares", () => {
	it("is the folder two above a folder under worktrees", () => {
		expect(sharedGitFolder(own)).toBe(root);
	});

	it("is none for a folder that isn't a worktree's own", () => {
		expect(sharedGitFolder(root)).toBeUndefined();
		expect(sharedGitFolder(undefined)).toBeUndefined();
	});
});

describe("what the watch guards", () => {
	it("guards the names git never makes in the shared folder", () => {
		const names = guardedNames(root, own);
		expect(names.get(root)).toEqual(["commondir", "gitdir"]);
		expect(names.get(own), "config.worktree is read by nothing").toEqual([]);
	});

	it("guards config.worktree where the settings have git read it", () => {
		writeFileSync(
			join(root, "config"),
			"[extensions]\n\tworktreeConfig = true\n",
		);
		const names = guardedNames(root, own);
		expect(names.get(root)).toEqual(["commondir", "gitdir", "config.worktree"]);
		expect(names.get(own)).toEqual(["config.worktree"]);
	});

	it("leaves a config.worktree already there to the read-only bind", () => {
		writeFileSync(
			join(root, "config"),
			"[extensions]\n\tworktreeConfig = on\n",
		);
		writeFileSync(join(own, "config.worktree"), "");
		expect(guardedNames(root, own).get(own)).toEqual([]);
	});
});

describe("a plant in the shared git folder", () => {
	it.each([
		["commondir", () => join(root, "commondir")],
		["gitdir", () => join(root, "gitdir")],
		["config.worktree at the root", () => join(root, "config.worktree")],
		[
			"config.worktree in the tree's own folder",
			() => join(own, "config.worktree"),
		],
	])(
		"removes %s at once and logs and stops the session",
		async (_name, path) => {
			writeFileSync(
				join(root, "config"),
				"[extensions]\n\tworktreeConfig = true\n",
			);
			const deps = watched();
			expect(armSharedRoot(root, own, "s-1", deps), "the watch armed").toBe(
				true,
			);
			const planted = path();
			const at = Date.now();
			writeFileSync(planted, "/elsewhere\n");
			await vi.waitFor(
				() => expect(existsSync(planted), `${planted} still there`).toBe(false),
				{ timeout: PROMPTLY_MS, interval: 2 },
			);
			expect(Date.now() - at, "how long it stood").toBeLessThan(PROMPTLY_MS);
			expect(deps.refused, "the refusal logged").toHaveBeenCalledWith("s-1");
			expect(deps.stop, "the session's commands stopped").toHaveBeenCalledWith(
				"s-1",
			);
			expect(plantStopped("s-1"), "later commands refused").toBe(true);
		},
	);

	it("stops the session however fast plants come, leaving none", async () => {
		const deps = watched();
		armSharedRoot(root, own, "s-loop", deps);
		const planted = join(root, "commondir");
		for (let round = 0; round < 50; round += 1) {
			try {
				writeFileSync(planted, "/elsewhere\n");
			} catch {
				// Removed between the open and the write: one more caught.
			}
		}
		await vi.waitFor(
			() => expect(existsSync(planted), "a plant still there").toBe(false),
			{ timeout: PROMPTLY_MS, interval: 2 },
		);
		expect(plantStopped("s-loop"), "the session stopped").toBe(true);
		expect(deps.stop, "its commands ended").toHaveBeenCalledWith("s-loop");
	});

	it("logs and stops every session that could have written the folder", async () => {
		const deps = watched();
		armSharedRoot(root, own, "s-a", deps);
		armSharedRoot(root, own, "s-b", deps);
		writeFileSync(join(root, "gitdir"), "/elsewhere\n");
		await vi.waitFor(
			() => expect(plantStopped("s-b"), "s-b stopped").toBe(true),
			{
				timeout: PROMPTLY_MS,
				interval: 2,
			},
		);
		expect(plantStopped("s-a"), "s-a stopped").toBe(true);
		expect(deps.refused.mock.calls.flat().sort()).toEqual(["s-a", "s-b"]);
	});

	it("leaves the session alone for what git writes there", async () => {
		const deps = watched();
		armSharedRoot(root, own, "s-git", deps);
		writeFileSync(join(root, "packed-refs.lock"), "");
		writeFileSync(join(own, "index.lock"), "");
		// Nothing should follow, so there is no event to wait on: a real
		// pause past the time a plant takes to be removed is the point.
		await new Promise((done) => setTimeout(done, 30));
		expect(deps.refused, "no refusal").not.toHaveBeenCalled();
		expect(plantStopped("s-git"), "not stopped").toBe(false);
	});
});

describe("a shared git folder the watch can't guard", () => {
	it("stays read-only when it already holds a commondir", () => {
		writeFileSync(join(root, "commondir"), "/elsewhere\n");
		const deps = watched();
		expect(armSharedRoot(root, own, "s-1", deps), "armed").toBe(false);
		expect(
			sharedRootFor(own, "s-1", () => true),
			"writable",
		).toBeUndefined();
		expect(guardedIn([root]), "anything guarded").toEqual([]);
	});

	it("stays read-only when the watch can't be armed", () => {
		const watch = () => {
			throw new Error("no inotify watches left");
		};
		expect(
			armSharedRoot(root, own, "s-1", { ...watched(), watch }),
			"armed",
		).toBe(false);
	});

	it("stays read-only when the fence doesn't guard it, or there's no session", () => {
		expect(
			sharedRootFor(own, "s-1", () => false),
			"unguarded",
		).toBeUndefined();
		expect(
			sharedRootFor(own, undefined, () => true),
			"no session",
		).toBeUndefined();
	});

	it("is made writable once armed, with its empty folders made first", () => {
		expect(sharedRootFor(own, "s-1", () => true)).toBe(root);
		for (const name of ["hooks", "info", "modules"])
			expect(existsSync(join(root, name)), `${name} made`).toBe(true);
		expect(guardedIn([root, own])).toEqual([
			join(root, "commondir"),
			join(root, "gitdir"),
		]);
	});
});

describe("the shared git folder's binds", () => {
	it("binds the folder writable and what runs code read-only over it", () => {
		const there = (path: string) => !path.endsWith("/modules");
		const args = sharedRootArgs(root, there);
		expect(args.slice(0, 3)).toEqual(["--bind", root, root]);
		const kept = ROOT_KEPT.filter((name) => name !== "modules").map((name) =>
			join(root, name),
		);
		expect(args.slice(3)).toEqual(
			kept.flatMap((path) => ["--ro-bind", path, path]),
		);
	});
});

describe("the shared git folder among the fence's binds", () => {
	const home = "/h";
	const shared = "/h/src/r/.git";
	const mine = `${shared}/worktrees/wt`;
	const files = [
		`${shared}/config`,
		`${shared}/HEAD`,
		`${mine}/HEAD`,
		`${shared}/worktrees/other/HEAD`,
		"/h/trees/wt/.git",
	];
	const folders = new Set<string>();
	for (const file of files)
		for (let up = file; up.lastIndexOf("/") > 0; ) {
			up = up.slice(0, up.lastIndexOf("/"));
			folders.add(up);
		}
	for (const name of ["hooks", "info", "objects", "refs"])
		folders.add(`${shared}/${name}`);
	const disk: Disk = {
		kind: (path) =>
			files.includes(path) ? "file" : folders.has(path) ? "folder" : undefined,
		entries: (folder) =>
			[...files, ...folders]
				.filter((path) => path.slice(0, path.lastIndexOf("/")) === folder)
				.map((path) => path.slice(folder.length + 1)),
	};
	const place = {
		home,
		runtimeDir: undefined,
		cwd: "/h/trees/wt",
		ownGitFolder: mine,
	};

	/** Where `flag` binds `path` in `args`, or -1. */
	function at(args: string[], flag: string, path: string): number {
		return args.findIndex(
			(arg, index) =>
				arg === flag && args[index + 1] === path && args[index + 2] === path,
		);
	}

	it("binds it writable, what runs code read-only over it, then the tree's own back", () => {
		const args = fenceArgs({ ...place, sharedRoot: shared }, disk);
		const writable = at(args, "--bind", shared);
		expect(writable, "the folder writable").toBeGreaterThan(-1);
		for (const name of ["config", "hooks", "info", "worktrees"])
			expect(
				at(args, "--ro-bind", `${shared}/${name}`),
				`${name} read-only after it`,
			).toBeGreaterThan(writable);
		expect(
			at(args, "--bind", mine),
			"the tree's own folder after",
		).toBeGreaterThan(at(args, "--ro-bind", `${shared}/worktrees`));
	});

	it("leaves it read-only without a watch", () => {
		expect(at(fenceArgs(place, disk), "--bind", shared)).toBe(-1);
	});
});

describe("the after-check", () => {
	/** The status and output of `script` then the after-check, in sh. */
	function checked(script: string, guarded: string[], log = "echo logged") {
		return spawnSync("sh", ["-c", `${script}\n${afterCheck(guarded, log)}`], {
			encoding: "utf8",
		});
	}

	it("keeps the command's status, and is empty with nothing guarded", () => {
		expect(checked("exit 3", [join(root, "commondir")]).status).toBe(3);
		expect(checked("true", [join(root, "commondir")]).status).toBe(0);
		expect(afterCheck([], "echo logged")).toBe("");
	});

	it("removes a plant the watch missed, link or folder, and logs it", () => {
		const planted = join(root, "commondir");
		const ran = checked(`mkdir ${planted}`, [planted]);
		expect(existsSync(planted), "the plant").toBe(false);
		expect(ran.stdout.trim()).toBe("logged");
		const linked = checked(`ln -s /nowhere ${planted}`, [planted]);
		expect(linked.stdout.trim(), "a dangling link logged").toBe("logged");
	});

	it("logs nothing when nothing was planted", () => {
		expect(checked("true", [join(root, "commondir")]).stdout).toBe("");
	});
});

describe("ending a session's fenced commands", () => {
	/** A stand-in /proc entry for `pid`. */
	function process_(proc: string, pid: number, comm: string, env: string[]) {
		const at = join(proc, String(pid));
		mkdirSync(at, { recursive: true });
		writeFileSync(
			join(at, "status"),
			`Name:\t${comm}\nUid:\t${process.getuid?.()}\t0\t0\t0\n`,
		);
		writeFileSync(join(at, "comm"), `${comm}\n`);
		writeFileSync(join(at, "environ"), `${env.join("\0")}\0`);
	}

	it("ends only this session's bubblewraps", () => {
		const proc = join(base, "proc");
		process_(proc, 11, "bwrap", ["PI_SESSION_ID=s-1", "HOME=/h"]);
		process_(proc, 12, "bwrap", ["PI_SESSION_ID=s-2"]);
		process_(proc, 13, "bash", ["PI_SESSION_ID=s-1"]);
		process_(proc, 14, "bwrap", ["PI_SESSION_ID=s-10"]);
		mkdirSync(join(proc, "self"));
		const killed: number[] = [];
		expect(endFencedCommands("s-1", proc, (pid) => killed.push(pid))).toBe(1);
		expect(killed).toEqual([11]);
	});

	it("ends none of another account's", () => {
		const proc = join(base, "proc");
		process_(proc, 21, "bwrap", ["PI_SESSION_ID=s-1"]);
		writeFileSync(
			join(proc, "21", "status"),
			"Name:\tbwrap\nUid:\t4242\t0\t0\t0\n",
		);
		const killed: number[] = [];
		expect(endFencedCommands("s-1", proc, (pid) => killed.push(pid))).toBe(0);
	});
});

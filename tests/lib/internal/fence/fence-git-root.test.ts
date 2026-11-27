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
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fenceArgs } from "../../../../lib/internal/fence/fence.ts";
import type { Disk } from "../../../../lib/internal/fence/fence-disk.ts";
import {
	armSharedRoot,
	disarmAll,
	endFencedCommands,
	guardedFolders,
	guardedIn,
	guardedNames,
	plantStopped,
	sharedGitFolder,
	sharedRootFor,
	withAfterCheck,
	withAfterCheckIn,
} from "../../../../lib/internal/fence/fence-git-root.ts";
import { systemRmCommand } from "../../../../lib/internal/files/remove-tree.ts";

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
	it("guards the names git never makes there, and config.worktree whatever the settings say", () => {
		const names = guardedNames(root, own);
		expect(names.get(root)).toEqual(["commondir", "gitdir", "config.worktree"]);
		expect(
			names.get(own),
			"a sparse checkout turning it on later would wake one",
		).toEqual(["config.worktree"]);
	});

	it("leaves a config.worktree already there to the read-only bind", () => {
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
			const why = plantStopped("s-1");
			expect(why, "later commands refused, naming the folder").toContain(root);
			expect(why, "saying it may be collateral").toContain("collateral");
			expect(why, "saying how to get going again").toContain(
				"a new session works at once",
			);
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
		expect(plantStopped("s-loop"), "the session stopped").toBeDefined();
		expect(deps.stop, "its commands ended").toHaveBeenCalledWith("s-loop");
	});

	it("logs and stops every session that could have written the folder", async () => {
		const deps = watched();
		armSharedRoot(root, own, "s-a", deps);
		armSharedRoot(root, own, "s-b", deps);
		writeFileSync(join(root, "gitdir"), "/elsewhere\n");
		await vi.waitFor(
			() => expect(plantStopped("s-b"), "s-b stopped").toBeDefined(),
			{
				timeout: PROMPTLY_MS,
				interval: 2,
			},
		);
		expect(plantStopped("s-a"), "s-a stopped").toBeDefined();
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
		expect(plantStopped("s-git"), "not stopped").toBeUndefined();
	});
});

describe("a shared git folder the watch can't guard", () => {
	it("is left unwatched when it already holds a commondir", () => {
		writeFileSync(join(root, "commondir"), "/elsewhere\n");
		const deps = watched();
		expect(armSharedRoot(root, own, "s-1", deps), "armed").toBe(false);
		expect(
			sharedRootFor(own, "s-1", () => true),
			"watched",
		).toBeUndefined();
		expect(guardedIn([root]), "anything guarded").toEqual([]);
	});

	it("is left unwatched when the watch can't be armed", () => {
		const watch = () => {
			throw new Error("no inotify watches left");
		};
		expect(
			armSharedRoot(root, own, "s-1", { ...watched(), watch }),
			"armed",
		).toBe(false);
	});

	it("is left unwatched when the fence doesn't guard it, or there's no session", () => {
		expect(
			sharedRootFor(own, "s-1", () => false),
			"unguarded",
		).toBeUndefined();
		expect(
			sharedRootFor(own, undefined, () => true),
			"no session",
		).toBeUndefined();
	});

	it("is watched once armed, with nothing made in it", () => {
		expect(sharedRootFor(own, "s-1", () => true)).toBe(root);
		for (const name of ["hooks", "info", "modules"])
			expect(existsSync(join(root, name)), `${name} made`).toBe(false);
		expect(guardedIn([root, own])).toEqual([
			join(root, "commondir"),
			join(root, "gitdir"),
			join(root, "config.worktree"),
			join(own, "config.worktree"),
		]);
	});
});

describe("the folders watched for a session's worktrees", () => {
	it("are each held tree's shared and own folders, as the working tree's are, each once", () => {
		const other = join(base, "other", ".git");
		const held = join(other, "worktrees", "held");
		mkdirSync(held, { recursive: true });
		const second = join(root, "worktrees", "second");
		mkdirSync(second);
		const worktrees = {
			cwd: join(base, "tree"),
			ownGitFolder: own,
			heldWorktrees: [
				{ tree: join(base, "held"), gitFolder: held },
				{ tree: join(base, "second"), gitFolder: second },
				{ tree: join(base, "tree"), gitFolder: own },
			],
		};
		expect(guardedFolders(worktrees, "s-1", () => true)).toEqual([
			root,
			own,
			other,
			held,
			second,
		]);
		expect(
			guardedFolders(worktrees, "s-1", (folder) => folder !== other),
			"a held tree whose shared folder isn't guarded",
		).toEqual([root, own, second]);
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

	it("keeps it read-only, since a watch loses a race (check j), with objects and refs and the tree's own folder writable", () => {
		const args = fenceArgs(place, disk);
		expect(at(args, "--bind", shared), "the folder was writable").toBe(-1);
		for (const name of ["objects", "refs"])
			expect(
				at(args, "--bind", `${shared}/${name}`),
				`${name} wasn't writable`,
			).toBeGreaterThan(-1);
		expect(at(args, "--bind", mine), "the tree's own folder").toBeGreaterThan(
			-1,
		);
	});
});

describe("the after-check", () => {
	/** The status and output of `script` then the after-check, in sh. */
	function checked(script: string, guarded: string[], log = "echo logged") {
		return spawnSync("sh", ["-c", withAfterCheck(script, guarded, log)], {
			encoding: "utf8",
		});
	}

	it("keeps the command's status, and leaves the command alone with nothing guarded", () => {
		expect(checked("(exit 3)", [join(root, "commondir")]).status).toBe(3);
		expect(checked("true", [join(root, "commondir")]).status).toBe(0);
		expect(withAfterCheck("true", [], "echo logged")).toBe("true");
	});

	it("removes a plant the watch missed, link or folder, and logs it", () => {
		const planted = join(root, "commondir");
		const ran = checked(`mkdir ${planted}`, [planted]);
		expect(existsSync(planted), "the plant").toBe(false);
		expect(ran.stdout.trim()).toBe("logged");
		const linked = checked(`ln -s /nowhere ${planted}`, [planted]);
		expect(linked.stdout.trim(), "a dangling link logged").toBe("logged");
	});

	it("removes with the rm it is given by path, never one PATH finds", () => {
		const planted = join(root, "commondir");
		const bin = join(base, "bin");
		mkdirSync(bin);
		const used = join(base, "used");
		// A stand-in for the system's rm that says it ran, and one on PATH
		// that would say so too, so only the named one may be heard.
		const given = join(base, "given-rm");
		const rm = systemRmCommand();
		expect(rm, "an rm only root keeps on this machine").toBeDefined();
		writeFileSync(
			given,
			`#!/bin/sh\necho given >> '${used}'\nexec '${rm}' "$@"\n`,
			{
				mode: 0o755,
			},
		);
		writeFileSync(join(bin, "rm"), `#!/bin/sh\necho path >> '${used}'\n`, {
			mode: 0o755,
		});
		const ran = spawnSync(
			"sh",
			[
				"-c",
				withAfterCheck(
					`mkdir ${planted}`,
					[planted],
					"echo logged",
					undefined,
					given,
				),
			],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
			},
		);

		expect(ran.stdout.trim(), "the plant logged").toBe("logged");
		expect(existsSync(planted), "the plant").toBe(false);
		expect(readFileSync(used, "utf8"), "only the given rm ran").toBe("given\n");
	});

	it("removes with the system's rm as the fence runs it, whatever rm PATH finds first", () => {
		// The fence calls withAfterCheckIn and names no rm, so this is the
		// default a fenced command would most like to swap for its own.
		const runtimeDir = join(root, "run");
		mkdirSync(runtimeDir, { recursive: true });
		const planted = join(root, "commondir");
		const bin = join(base, "bin");
		mkdirSync(bin);
		const used = join(base, "used");
		writeFileSync(join(bin, "rm"), `#!/bin/sh\necho path >> '${used}'\n`, {
			mode: 0o755,
		});
		const text = withAfterCheckIn(
			runtimeDir,
			`mkdir '${planted}'`,
			[planted],
			"echo logged",
		);

		const ran = spawnSync("bash", ["-c", text], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
		});

		expect(ran.stdout, "the plant logged").toBe("logged\n");
		expect(existsSync(planted), "the plant").toBe(false);
		expect(existsSync(used), "PATH's rm ran").toBe(false);
	});

	it("leaves a plant and says so where no rm only root keeps is found", () => {
		const planted = join(root, "commondir");
		const text = withAfterCheck(
			`mkdir ${planted}`,
			[planted],
			"echo logged",
			undefined,
			null,
		);
		const ran = spawnSync("sh", ["-c", text], { encoding: "utf8" });

		expect(text, "no rm is run").not.toMatch(/\brm\b.*-rf/u);
		expect(existsSync(planted), "the plant stays").toBe(true);
		expect(ran.stderr).toContain("has no rm only root keeps to remove it");
		expect(ran.stdout.trim(), "and is logged").toBe("logged");
	});

	it("logs nothing when nothing was planted", () => {
		expect(checked("true", [join(root, "commondir")]).stdout).toBe("");
	});

	it("reads what it guards from a list file, removing and logging each plant, and says when the file is gone", () => {
		const planted = [join(root, "commondir"), join(root, "it's gitdir")];
		const list = join(root, "guarded-list");
		writeFileSync(list, planted.map((path) => `${path}\0`).join(""));
		const inBash = (script: string, file: string) =>
			spawnSync(
				"bash",
				["-c", withAfterCheck(script, planted, "echo logged", file)],
				{ encoding: "utf8" },
			);
		const ran = inBash(
			`mkdir '${planted[0]}'; touch "${planted[1]}"; (exit 4)`,
			list,
		);
		expect(ran.status, "the command's status").toBe(4);
		expect(
			planted.filter((path) => existsSync(path)),
			"a plant stayed",
		).toEqual([]);
		expect(ran.stdout).toBe("logged\nlogged\n");
		const text = withAfterCheck("true", planted, "echo logged", list);
		expect(text, "a guarded path went in the text").not.toContain("commondir");
		const gone = inBash("(exit 5)", join(root, "no-such-list"));
		expect(gone.status, "the command's status").toBe(5);
		expect(gone.stderr).toContain("couldn't read the list of git folders");
	});

	it("still checks what it guards when the list is taken away while the command runs", () => {
		const planted = join(root, "commondir");
		const list = join(root, "guarded-list");
		writeFileSync(list, `${planted}\0`);
		const ran = spawnSync(
			"bash",
			[
				"-c",
				withAfterCheck(
					`rm '${list}'; mkdir '${planted}'`,
					[planted],
					"echo logged",
					list,
				),
			],
			{ encoding: "utf8" },
		);
		expect(ran.stderr, "it said the list was gone").toBe("");
		expect(existsSync(planted), "the plant").toBe(false);
		expect(ran.stdout).toBe("logged\n");
	});

	it("puts what it guards in a file in the session's runtime folder, and inline only without one", () => {
		const runtimeDir = join(root, "run");
		mkdirSync(runtimeDir, { recursive: true });
		const planted = join(root, "commondir");
		const text = withAfterCheckIn(
			runtimeDir,
			`mkdir '${planted}'`,
			[planted],
			"echo logged",
		);
		expect(
			text.replace(`mkdir '${planted}'`, ""),
			"the guarded path went in the text",
		).not.toContain(planted);
		const ran = spawnSync("bash", ["-c", text], { encoding: "utf8" });
		expect(existsSync(planted), "the plant").toBe(false);
		expect(ran.stdout).toBe("logged\n");
		expect(
			withAfterCheckIn(undefined, "true", [planted], "echo logged"),
		).toContain(planted);
		expect(withAfterCheckIn(runtimeDir, "true", [], "echo logged")).toBe(
			"true",
		);
	});
});

describe("ending a session's fenced commands", () => {
	const OURS = "pid:[4026531836]";

	/** A stand-in /proc entry for `pid`, in pid namespace `space`. */
	function listed(
		proc: string,
		pid: number,
		comm: string,
		env: string[],
		space = OURS,
		uid = process.getuid?.(),
	) {
		const at = join(proc, String(pid));
		mkdirSync(join(at, "ns"), { recursive: true });
		writeFileSync(
			join(at, "status"),
			`Name:\t${comm}\nUid:\t${uid}\t0\t0\t0\n`,
		);
		writeFileSync(join(at, "comm"), `${comm}\n`);
		writeFileSync(join(at, "environ"), `${env.join("\0")}\0`);
		writeFileSync(
			join(at, "stat"),
			`${pid} (${comm} x) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${pid}00 0 0\n`,
		);
		symlinkSync(space, join(at, "ns", "pid"));
	}

	/** A stand-in /proc with this process's own namespace. */
	function proc(): string {
		const made = join(base, "proc");
		mkdirSync(join(made, "self", "ns"), { recursive: true });
		symlinkSync(OURS, join(made, "self", "ns", "pid"));
		return made;
	}

	/** Each signal sent, and the later step left to run. */
	function ending(at: string) {
		const sent: string[] = [];
		const steps: (() => void)[] = [];
		const given = {
			proc: at,
			signal: (pid: number, signal: string) => sent.push(`${signal} ${pid}`),
			later: (then: () => void, ms: number) => {
				expect(ms, "the grace before a kill").toBe(5000);
				steps.push(then);
			},
		};
		return { sent, steps, given };
	}

	it("asks this session's bubblewraps and everything in their namespace to end, then kills them", () => {
		const at = proc();
		const theirs = "pid:[4026533000]";
		listed(at, 11, "bwrap", ["PI_SESSION_ID=s-1", "HOME=/h"]);
		listed(at, 12, "bwrap", ["PI_SESSION_ID=s-1"], theirs);
		listed(at, 13, "sh", [], theirs);
		listed(at, 14, "sleep", [], theirs);
		listed(at, 15, "bwrap", ["PI_SESSION_ID=s-2"], "pid:[4026533001]");
		listed(at, 16, "bash", ["PI_SESSION_ID=s-1"]);
		listed(at, 17, "bwrap", ["PI_SESSION_ID=s-10"]);
		const { sent, steps, given } = ending(at);
		expect(endFencedCommands("s-1", given), "how many were asked").toBe(4);
		expect(sent).toEqual([
			"SIGTERM 11",
			"SIGTERM 12",
			"SIGTERM 13",
			"SIGTERM 14",
		]);
		rmSync(join(at, "13"), { recursive: true });
		for (const step of steps) step();
		expect(sent.slice(4), "killed but what ended").toEqual([
			"SIGKILL 11",
			"SIGKILL 12",
			"SIGKILL 14",
		]);
	});

	it("kills no process that took a pid freed in the grace", () => {
		const at = proc();
		listed(at, 21, "bwrap", ["PI_SESSION_ID=s-1"]);
		const { sent, steps, given } = ending(at);
		endFencedCommands("s-1", given);
		writeFileSync(
			join(at, "21", "stat"),
			"21 (other) S 1 21 21 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0 0\n",
		);
		for (const step of steps) step();
		expect(sent).toEqual(["SIGTERM 21"]);
	});

	it("ends none of another account's", () => {
		const at = proc();
		listed(at, 31, "bwrap", ["PI_SESSION_ID=s-1"], OURS, 4242);
		const { sent, given } = ending(at);
		expect(endFencedCommands("s-1", given)).toBe(0);
		expect(sent).toEqual([]);
	});
});

/**
 * The fence's binds over a real disk, through a real bubblewrap: what a
 * fenced command can and can't write in the repositories pi runs git in
 * outside the fence: a `git init` from a fenced command, followed by
 * pi's own git there, runs nothing; and what git in a worktree does
 * once its shared git folder is writable under the watch outside. It
 * skips only where no bubblewrap can make a namespace, as inside
 * another sandbox.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fenceArgs } from "../../../lib/internal/fence.ts";
import {
	armSharedRoot,
	disarmAll,
	endFencedCommands,
	plantStopped,
} from "../../../lib/internal/fence-git-root.ts";
import { gitRun } from "../../../lib/internal/tree-git.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

/** A bubblewrap on `PATH` that can make a namespace here, or nothing. */
function workingBwrap(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v bwrap"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, [
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		"true",
	]);
	return tried.status === 0 ? found : undefined;
}

const bwrap = workingBwrap();

describe.skipIf(bwrap === undefined)(
	"what a fenced command can write where pi runs git",
	() => {
		let home: string;
		let template: string;
		let checkout: string;

		/** Whether `script` succeeds as a fenced command in `home`. */
		function fenced(script: string): boolean {
			const args = fenceArgs({ home, runtimeDir: undefined });
			const ran = spawnSync(
				bwrap ?? "bwrap",
				["--unshare-user", ...args, "sh", "-c", script],
				{ encoding: "utf8" },
			);
			return ran.status === 0;
		}

		beforeAll(async () => {
			home = realpathSync(mkdtempSync(join(tmpdir(), "fence-bwrap-")));
			template = await freshRepo("fence-bwrap");
			checkout = join(home, "src", "r");
			mkdirSync(checkout, { recursive: true });
			cpSync(template, checkout, { recursive: true });
		});

		afterAll(() => {
			rmSync(home, { recursive: true, force: true });
			disposeRepo(template);
		});

		it("makes no repository in src, so pi's git there finds none", () => {
			const made = join(home, "src", "made");
			expect(fenced(`git init -q ${made}`), "git init ran").toBe(false);
			expect(existsSync(made), `${made} was made`).toBe(false);
			expect(
				gitRun(made, ["status"], {
					home,
					fenced: true,
					trees: join(home, "trees"),
				}),
			).toEqual({ args: ["-c", "core.fsmonitor=false", "status"] });
		});

		it("adds nothing to a checkout's git folder that sends git elsewhere", () => {
			const git = join(checkout, ".git");
			expect(fenced(`echo /tmp > ${git}/commondir`), "a commondir").toBe(false);
			expect(fenced(`mkdir ${git}/modules`), "a modules folder").toBe(false);
			expect(fenced(`echo x >> ${git}/config`), "its settings").toBe(false);
			expect(existsSync(join(git, "commondir")), "commondir is there").toBe(
				false,
			);
		});

		it("writes neither a checkout's files nor anything new in src", () => {
			expect(fenced(`touch ${checkout}/new-file`), "a checkout's file").toBe(
				false,
			);
			expect(fenced(`touch ${home}/src/new-file`), "a file in src").toBe(false);
		});

		it("still writes what a commit in a worktree writes", () => {
			const objects = join(checkout, ".git", "objects");
			expect(
				fenced(`touch ${objects}/probe && rm ${objects}/probe`),
				"an object",
			).toBe(true);
			expect(
				fenced(`touch ${checkout}/.git/refs/heads/probe.lock`),
				"a ref's lock",
			).toBe(true);
		});
	},
);

describe.skipIf(bwrap === undefined)(
	"git in a fenced worktree whose shared git folder is watched",
	() => {
		let home: string;
		let remote: string;
		let root: string;
		let tree: string;
		let own: string;

		/** How `script` ran as a fenced command in the worktree. */
		function fencedIn(script: string, shared: boolean) {
			const args = fenceArgs({
				home,
				runtimeDir: undefined,
				cwd: tree,
				ownGitFolder: own,
				sharedRoot: shared ? root : undefined,
			});
			return spawnSync(
				bwrap ?? "bwrap",
				[
					"--unshare-user",
					...args,
					"--chdir",
					tree,
					"--setenv",
					"GIT_OPTIONAL_LOCKS",
					"0",
					"sh",
					"-c",
					script,
				],
				{ encoding: "utf8" },
			);
		}

		beforeAll(async () => {
			home = realpathSync(mkdtempSync(join(tmpdir(), "fence-bwrap-tree-")));
			remote = await freshRepo("fence-bwrap-remote");
			await git(remote, "branch", "old");
			const checkout = join(home, "src", "w");
			mkdirSync(checkout, { recursive: true });
			cpSync(remote, checkout, { recursive: true });
			root = join(checkout, ".git");
			tree = join(home, "trees", "wt");
			await git(checkout, "branch", "gone");
			await git(checkout, "worktree", "add", "-q", "-b", "work", tree);
			await git(
				checkout,
				"worktree",
				"add",
				"-q",
				"-b",
				"other",
				join(home, "trees", "other"),
			);
			await git(
				checkout,
				"fetch",
				"-q",
				remote,
				"+refs/heads/*:refs/remotes/o/*",
			);
			await git(checkout, "pack-refs", "--all");
			await git(remote, "branch", "-D", "old");
			own = join(root, "worktrees", "wt");
		});

		afterAll(() => {
			disarmAll();
			rmSync(home, { recursive: true, force: true });
			disposeRepo(remote);
		});

		it("deletes a packed branch only once the shared folder is writable", () => {
			const refused = fencedIn("git branch -d gone", false);
			expect(refused.status, "deleted while read-only").not.toBe(0);
			expect(refused.stderr, "why it was refused").toContain("packed-refs");
			const ran = fencedIn("git branch -d gone", true);
			expect(ran.status, ran.stderr).toBe(0);
		});

		it("commits, rebases, fetches with prune and reads status inside", () => {
			const ran = fencedIn(
				[
					"set -e",
					"echo x > f && git add f && git commit -qm x",
					"git rebase -q main",
					"git status --short",
					`git fetch -q --prune ${remote} '+refs/heads/*:refs/remotes/o/*'`,
					"! git rev-parse -q --verify refs/remotes/o/old",
				].join("\n"),
				true,
			);
			expect(ran.status, ran.stderr).toBe(0);
		});

		it("keeps settings, hooks, submodules and other trees' folders read-only", () => {
			for (const path of [
				"config",
				"hooks/pre-commit",
				"info/attributes",
				"modules/x",
				"worktrees/other/HEAD",
			])
				expect(
					fencedIn(`echo x >> ${join(root, path)}`, true).status,
					`${path} was written`,
				).not.toBe(0);
		});

		it("loses a commondir planted from inside at once, and stops the session", async () => {
			const refused = vi.fn();
			expect(
				armSharedRoot(root, own, "s-bwrap", { refused, stop: vi.fn() }),
				"the watch armed",
			).toBe(true);
			const planted = join(root, "commondir");
			expect(fencedIn(`echo /elsewhere > ${planted}`, true).status).toBe(0);
			await vi.waitFor(
				() => expect(existsSync(planted), "the plant").toBe(false),
				{ timeout: 100, interval: 2 },
			);
			expect(refused).toHaveBeenCalledWith("s-bwrap");
			expect(plantStopped("s-bwrap"), "why").toContain(root);
		});

		it("ends a stopped session's command, children that ignore the ask included", async () => {
			const session = `s-end-${randomUUID()}`;
			const args = fenceArgs({ home, runtimeDir: undefined });
			const running = spawn(
				bwrap ?? "bwrap",
				[
					"--unshare-user",
					...args,
					"sh",
					"-c",
					"trap '' TERM; sh -c \"trap '' TERM; sleep 60\" & echo up; wait",
				],
				{ env: { ...process.env, PI_SESSION_ID: session } },
			);
			const ended = new Promise<void>((done) =>
				running.on("exit", () => done()),
			);
			await new Promise<void>((done) =>
				running.stdout.once("data", () => done()),
			);
			const asked: number[] = [];
			endFencedCommands(session, {
				signal: (pid, signal) => {
					asked.push(pid);
					process.kill(pid, signal);
				},
				// The grace is cut short here: what's tested is the kill after it.
				later: (then) => setImmediate(then),
			});
			expect(
				new Set(asked).size,
				"the bubblewraps, the shells and the sleep",
			).toBeGreaterThan(3);
			await ended;
			const alive = (pid: number) => {
				try {
					return !/^State:\s+Z/m.test(
						readFileSync(`/proc/${pid}/status`, "utf8"),
					);
				} catch {
					// Gone, and reaped.
					return false;
				}
			};
			await vi.waitFor(
				() => expect(asked.filter(alive), "left running").toEqual([]),
				{ timeout: 2000 },
			);
		});
	},
);

/** A script for node that exits 0 once it connects to its socket. */
const CONNECT = [
	"const s = require('node:net').connect(process.argv[1]);",
	"s.on('connect', () => process.exit(0));",
	"s.on('error', () => process.exit(2));",
].join(" ");

/** A socket served at `path` until closed. */
function serve(path: string): Promise<Server> {
	return new Promise((settle, fail) => {
		const server = createServer((socket) => socket.end());
		server.once("error", fail);
		server.listen(path, () => settle(server));
	});
}

describe.skipIf(bwrap === undefined)(
	"the clipboard door and the sandboxed display, from a fenced command",
	() => {
		let base: string;
		let home: string;
		let runtimeDir: string;
		let door: string;
		let display: string;
		let shims: string;
		const servers: Server[] = [];

		/** Whether `program` with `args` succeeds as a fenced command. */
		function fenced(
			program: string,
			args: readonly string[],
		): Promise<boolean> {
			const bound = fenceArgs({ home, runtimeDir });
			return new Promise((settle) => {
				execFile(
					bwrap ?? "bwrap",
					["--unshare-user", ...bound, program, ...args],
					{ timeout: 20_000 },
					(error) => settle(error === null),
				);
			});
		}

		beforeAll(async () => {
			// Not resolved, since a Unix socket's path may be at most 107
			// bytes and TMPDIR may be a short link to a long folder.
			base = mkdtempSync(join(tmpdir(), "fd-"));
			home = join(base, "home");
			runtimeDir = join(base, "run");
			mkdirSync(join(runtimeDir, "pi-clipboard"), {
				recursive: true,
				mode: 0o700,
			});
			mkdirSync(join(runtimeDir, "pi-fence"), { mode: 0o700 });
			shims = join(home, ".local", "share", "pi-fence", "bin");
			mkdirSync(shims, { recursive: true });
			writeFileSync(join(shims, "wl-copy"), "#!/bin/sh\n");
			door = join(runtimeDir, "pi-clipboard", "door.sock");
			display = join(runtimeDir, "pi-fence", "wayland");
			servers.push(
				await serve(door),
				await serve(display),
				await serve(join(runtimeDir, "wayland-1")),
			);
		});

		afterAll(async () => {
			await Promise.all(
				servers.map((server) => new Promise((settle) => server.close(settle))),
			);
			rmSync(base, { recursive: true, force: true });
		});

		it("reaches the clipboard door and the sandboxed display, and never niri's own display", async () => {
			const node = process.execPath;
			expect(await fenced(node, ["-e", CONNECT, door]), "the door").toBe(true);
			expect(
				await fenced(node, ["-e", CONNECT, display]),
				"the sandboxed display",
			).toBe(true);
			expect(
				await fenced(node, ["-e", CONNECT, join(runtimeDir, "wayland-1")]),
				"niri's own display",
			).toBe(false);
		});

		it("replaces neither socket, nor the shims, for every other session's commands to reach", async () => {
			for (const [what, script] of [
				["the door's socket removed", `rm -f ${door}`],
				["the display's socket removed", `rm -f ${display}`],
				["a socket planted beside the door", `touch ${door}.new`],
				["a program planted among the shims", `touch ${shims}/wl-paste`],
				["a shim rewritten", `echo exit 0 > ${shims}/wl-copy`],
				[
					"the shims' folder moved",
					`mv ${shims} ${join(home, ".local", "share", "moved")}`,
				],
			] as const) {
				expect(await fenced("sh", ["-c", script]), what).toBe(false);
			}
			expect(existsSync(door), "the door's socket is there").toBe(true);
			expect(existsSync(display), "the display's socket is there").toBe(true);
			expect(existsSync(join(shims, "wl-paste")), "a shim was planted").toBe(
				false,
			);
		});
	},
);

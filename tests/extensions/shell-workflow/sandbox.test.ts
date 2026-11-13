/**
 * A session that asks for the sandbox runs each command under landrun,
 * with nothing of the person's but what the strict profile names, and
 * runs none at all where the sandbox can't be had.
 *
 * Most cases run real commands through the agent's bash with a stand-in
 * for landrun that keeps only the variables it is told to, as landrun
 * does, so what is checked is the shell text the sandbox writes. The last
 * runs landrun itself, where it is on PATH.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBash } from "../../../extensions/shell-workflow/agent-bash.ts";
import {
	askTheCloudAhead,
	NIX_DOOR,
	questScratch,
	type Sandbox,
	sandboxFolders,
	sandboxFor,
	strictRules,
	unfencedFolder,
} from "../../../lib/internal/sandbox.ts";
import { systemProgram } from "../../../lib/internal/system-program.ts";
import { worktreeRepository } from "../../../lib/internal/tree-git.ts";

/** Lay out a repository's git folder with one worktree's own folder in it. */
function worktreeLayout(base: string, tree: string, back: string): string {
	const repository = join(base, "repo/.git");
	const own = join(repository, "worktrees/tree");
	mkdirSync(join(repository, "objects"), { recursive: true });
	mkdirSync(own, { recursive: true });
	mkdirSync(tree, { recursive: true });
	writeFileSync(join(own, "gitdir"), `${back}\n`);
	writeFileSync(join(tree, ".git"), `gitdir: ${own}\n`);
	return repository;
}

/**
 * Run a command as a session with `sandbox` would; its text and exit. It
 * runs in the temporary folder unless told otherwise, not the folder the
 * tests started in: the strict sandbox refuses a plain clone's, which holds
 * its git folder, so the tests would fail wherever they're checked out so.
 */
async function run(
	sandbox: Sandbox,
	command: string,
	cwd = tmpdir(),
): Promise<string> {
	const bash = agentBash(cwd, {}, sandbox);
	try {
		const result = await bash.execute(
			"t",
			{ command },
			undefined,
			undefined,
			undefined as never,
		);
		return result.content[0]?.type === "text" ? result.content[0].text : "";
	} catch (error) {
		return (error as Error).message;
	}
}

describe("what a session asks for", () => {
	const found = () => "/bin/landrun";

	it("is no sandbox when it asks for none", () => {
		expect(sandboxFor({}, "linux", found)).toEqual({ kind: "none" });
	});

	it("is the strict sandbox on Linux with landrun", () => {
		const github = () => undefined;
		const gcloud = () => ({ reason: "none here" });
		expect(
			sandboxFor({ PI_SANDBOX: "strict" }, "linux", found, github, gcloud),
		).toEqual({
			kind: "strict",
			landrun: "/bin/landrun",
			github,
			gcloud,
			// This finder answers one path for every program, the logger's too.
			logger: "/bin/landrun",
		});
	});

	it("runs nothing where the sandbox can't be had", () => {
		for (const [env, platform, find] of [
			[{ PI_SANDBOX: "strict" }, "darwin", found],
			[{ PI_SANDBOX: "strict" }, "linux", () => undefined],
			[{ PI_SANDBOX: "loose" }, "linux", found],
		] as const) {
			expect(sandboxFor(env, platform, find).kind).toBe("refused");
		}
	});
});

describe("the strict profile", () => {
	const rules = strictRules({
		home: "/home/someone",
		runtimeDir: "/run/user/1000",
		cwd: "/home/someone/src/thing",
	});
	const paths = (flag: string) =>
		rules.filter(([given]) => given === flag).map(([, path]) => path);

	it("lets nothing in the home folder be read but settings, the work and its own cache", () => {
		const home = [...paths("--ro"), ...paths("--rox"), ...paths("--rw")]
			.filter((path) => path.startsWith("/home/someone"))
			.sort();
		expect(home).toEqual(
			[
				"/home/someone/.cache/pi-sandbox/cache",
				"/home/someone/.cache/pi-sandbox/gcloud",
				"/home/someone/.cache/pi-sandbox/tmp",
				"/home/someone/.config/dev",
				"/home/someone/.config/git",
				"/home/someone/.config/nix/nix.conf",
				"/home/someone/.gitconfig",
				"/home/someone/.local/state/nix/profile",
				"/home/someone/.nix-profile",
				"/home/someone/src/thing",
			].sort(),
		);
	});

	it("lets a worktree's repository be read and never written", () => {
		const given = strictRules({
			home: "/home/someone",
			runtimeDir: undefined,
			cwd: "/home/someone/trees/thing",
			repository: "/home/someone/src/thing/.git",
		});
		const flags = given
			.filter(([, path]) => path === "/home/someone/src/thing/.git")
			.map(([flag]) => flag);
		expect(flags).toEqual(["--ro"]);
	});

	it("reaches no socket but name lookups and Nix's door for sandboxes", () => {
		expect(paths("--unix")).toEqual([
			"/run/nscd/socket",
			`/run/user/1000/${NIX_DOOR}`,
		]);
		expect(paths("--env")).toEqual([
			"TMPDIR=/home/someone/.cache/pi-sandbox/tmp",
			"XDG_CACHE_HOME=/home/someone/.cache/pi-sandbox/cache",
			`NIX_REMOTE=unix:///run/user/1000/${NIX_DOOR}`,
		]);
	});
});

describe("a working folder the sandbox won't let commands write", () => {
	let home: string;

	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), "sandbox-home-"));
		mkdirSync(join(home, "checkout/.git"), { recursive: true });
		mkdirSync(join(home, "worktree"));
		writeFileSync(join(home, "worktree/.git"), "gitdir: elsewhere\n");
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	it("is the home folder, or one holding it", () => {
		expect(unfencedFolder(home, home)).toContain("startup files");
		expect(unfencedFolder(join(home, ".."), home)).toContain("startup files");
	});

	it("is one holding its repository's git folder, and not a worktree", () => {
		expect(unfencedFolder(join(home, "checkout"), home)).toContain("hooks");
		expect(unfencedFolder(join(home, "worktree"), home)).toBeUndefined();
		expect(unfencedFolder(join(home, "checkout/src"), home)).toBeUndefined();
	});

	it("runs no command there, and says why", async () => {
		const answer = await run(
			{ kind: "strict", landrun: "/nowhere/landrun" },
			"echo ran",
			join(home, "checkout"),
		);
		expect(answer).toContain("work tree");
		expect(answer).not.toMatch(/^ran$/m);
	});
});

describe("a worktree's repository", () => {
	let base: string;

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "sandbox-repository-"));
	});

	afterAll(() => rmSync(base, { recursive: true, force: true }));

	it("is the git folder the worktree's .git names, when it points back", () => {
		const tree = join(base, "back/tree");
		const repository = worktreeLayout(
			join(base, "back"),
			tree,
			join(tree, ".git"),
		);
		expect(worktreeRepository(tree, "/nowhere-home")).toBe(
			realpathSync(repository),
		);
	});

	it("is nothing when the folder named points at another worktree", () => {
		const tree = join(base, "other/tree");
		worktreeLayout(join(base, "other"), tree, join(base, "elsewhere/.git"));
		expect(worktreeRepository(tree, "/nowhere-home")).toBeUndefined();
	});

	it("is nothing when the folder named isn't a worktree's own", () => {
		const tree = join(base, "loose/tree");
		const planted = join(base, "loose/secrets");
		mkdirSync(join(planted, "objects"), { recursive: true });
		mkdirSync(tree, { recursive: true });
		writeFileSync(join(planted, "gitdir"), `${join(tree, ".git")}\n`);
		writeFileSync(join(tree, ".git"), `gitdir: ${planted}\n`);
		expect(worktreeRepository(tree, "/nowhere-home")).toBeUndefined();
	});

	it("is nothing when the repository holds the home folder", () => {
		const tree = join(base, "home/tree");
		const repository = worktreeLayout(
			join(base, "home"),
			tree,
			join(tree, ".git"),
		);
		const home = join(repository, "inside");
		mkdirSync(home);
		expect(worktreeRepository(tree, home)).toBeUndefined();
	});

	it("is nothing in a folder with no .git file", () => {
		expect(worktreeRepository(base, "/nowhere-home")).toBeUndefined();
	});
});

describe("a session's quest scratch folder", () => {
	it("is the one its TMPDIR leads into, through a link, and none elsewhere", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-scratch-")));
		const root = join(base, "quest-workspace");
		mkdirSync(join(root, "QEST-1/tmp"), { recursive: true });
		const link = join(base, "pi-quest-QEST-1");
		symlinkSync(join(root, "QEST-1/tmp"), link);
		try {
			expect(questScratch(link, root)).toEqual({
				root,
				own: join(root, "QEST-1"),
			});
			expect(questScratch(join(base, "other"), root)).toEqual({ root });
			expect(questScratch(root, root), "the root is no quest's").toEqual({
				root,
			});
			expect(questScratch(undefined, root)).toEqual({ root });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("a command in the sandbox", () => {
	let folder: string;
	let sandbox: Extract<Sandbox, { kind: "strict" }>;

	beforeAll(() => {
		folder = mkdtempSync(join(tmpdir(), "sandbox-"));
		// Keeps only the variables named with --env, as landrun does, and
		// runs what follows `--`.
		const landrun = join(folder, "landrun");
		writeFileSync(
			landrun,
			[
				"#!/usr/bin/env bash",
				"kept=()",
				'while [ "$1" != -- ]; do',
				"  case $1 in",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
				'    --env) case $2 in *=*) kept+=("$2");; *) [ -n "${!2+set}" ] && kept+=("$2=${!2}");; esac; shift 2;;',
				"    --unrestricted-network|--ignore-missing) shift;;",
				"    *) shift 2;;",
				"  esac",
				"done",
				"shift",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
				'exec env -i "${kept[@]}" "$@"',
			].join("\n"),
		);
		chmodSync(landrun, 0o755);
		sandbox = { kind: "strict", landrun };
	});

	afterAll(() => rmSync(folder, { recursive: true, force: true }));

	it("runs with its output and its exit as they were", async () => {
		const answer = await run(sandbox, "echo inside; exit 7");
		expect(answer).toContain("inside");
		expect(answer).toContain("exit");
		expect(answer).toContain("7");
	});

	it("shows its text on no process's command line, and leaves no copy behind", async () => {
		const answer = await run(
			sandbox,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
			'tr "\\0" " " < /proc/$$/cmdline; echo; echo "copy:${PI_SANDBOXED_COMMAND-none}" # marker-in-text',
		);
		expect(answer).not.toMatch(/marker-in-text.*\n.*copy/);
		expect(answer).toContain("copy:none");
		expect(answer.split("\n")[0]).not.toContain("marker-in-text");
	});

	it("keeps only harmless variables, never a token, and points Nix and the cache at its own", async () => {
		const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
		process.env.SANDBOX_TEST_HOME = "kept";
		process.env.SANDBOX_TEST_TOKEN_HOME = "a-token";
		process.env.SANDBOX_TEST_OTHER = "unknown";
		process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
		const answer = await run(
			sandbox,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
			'echo "$SANDBOX_TEST_HOME ${DBUS_SESSION_BUS_ADDRESS-nobus} $NIX_REMOTE"; echo "own:$XDG_CACHE_HOME $TMPDIR"; echo "dropped:${SANDBOX_TEST_TOKEN_HOME-none} ${SANDBOX_TEST_OTHER-none} path:${PATH:+set}"',
		).finally(() => {
			delete process.env.SANDBOX_TEST_HOME;
			delete process.env.SANDBOX_TEST_TOKEN_HOME;
			delete process.env.SANDBOX_TEST_OTHER;
			if (bus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
			else process.env.DBUS_SESSION_BUS_ADDRESS = bus;
		});
		const runtime = process.env.XDG_RUNTIME_DIR;
		expect(answer).toContain(
			`kept nobus ${runtime ? `unix://${runtime}/${NIX_DOOR}` : ""}`.trim(),
		);
		const own = sandboxFolders(homedir());
		expect(answer).toContain(`own:${own.cache} ${own.temporary}`);
		expect(answer).toContain("dropped:none none path:set");
	});

	it("hands gh and git the broker's token for github.com alone, on no command line", async () => {
		const token = "ghs_0123456789abcdefghijABCDEFGHIJ";
		const home = join(folder, "home");
		const work = join(home, "work");
		mkdirSync(work, { recursive: true });
		// The person's own helper, which runs outside the sandbox's reach.
		writeFileSync(
			join(home, ".gitconfig"),
			'[credential]\n\thelper = "!f() { echo username=me; echo password=persons; }; f"\n',
		);
		const before = process.env.HOME;
		process.env.HOME = home;
		const answer = await run(
			{ ...sandbox, github: () => token },
			[
				'echo "gh:$GH_TOKEN"',
				'tr "\\0" " " < /proc/$$/cmdline; echo',
				"printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
				"printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill",
			].join("; "),
			work,
		).finally(() => {
			process.env.HOME = before;
		});
		const lines = answer.split("\n");
		expect(lines[0]).toBe(`gh:${token}`);
		expect(lines[1]).not.toContain(token);
		expect(answer).toContain(
			`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}`,
		);
		expect(answer).toContain("host=example.com\nusername=me\npassword=persons");
		expect(answer.match(/password=persons/g)).toHaveLength(1);
	});

	it("hands gcloud the broker's token, its project and the session's own settings, on no command line", async () => {
		const token = `ya29.${"a0B1-c2_D3".repeat(20)}`;
		const home = join(folder, "cloud-home");
		const work = join(home, "work");
		mkdirSync(work, { recursive: true });
		// pi names no session here, so the folder is the process's own.
		const settings = join(sandboxFolders(home).gcloud, `pid-${process.pid}`);
		// Left by an earlier run of the same session, which starts over.
		mkdirSync(settings, { recursive: true });
		writeFileSync(join(settings, "left"), "");
		const [before, session] = [process.env.HOME, process.env.PI_SESSION_ID];
		process.env.HOME = home;
		delete process.env.PI_SESSION_ID;
		const answer = await run(
			{ ...sandbox, gcloud: () => ({ token, project: "a-lab-project" }) },
			[
				'echo "$CLOUDSDK_AUTH_ACCESS_TOKEN $CLOUDSDK_CORE_PROJECT $CLOUDSDK_CONFIG"',
				'tr "\\0" " " < /proc/$$/cmdline; echo',
				'ls -A "$CLOUDSDK_CONFIG"; echo listed',
			].join("; "),
			work,
		).finally(() => {
			process.env.HOME = before;
			if (session === undefined) delete process.env.PI_SESSION_ID;
			else process.env.PI_SESSION_ID = session;
		});
		const lines = answer.split("\n");
		expect(lines[0]).toBe(`${token} a-lab-project ${settings}`);
		expect(lines[1]).not.toContain(token);
		expect(lines[2]).toBe("listed");
		expect(statSync(settings).mode & 0o777).toBe(0o700);
	});

	it("tells a command naming gcloud why it has no token, and hands it none but its own empty settings", async () => {
		const unbrokered = {
			...sandbox,
			gcloud: () => ({ reason: "gcloud-broker isn't on this machine" }),
		};
		const home = join(folder, "unbrokered-home");
		const work = join(home, "work");
		mkdirSync(work, { recursive: true });
		const settings = join(sandboxFolders(home).gcloud, `pid-${process.pid}`);
		const [before, session] = [process.env.HOME, process.env.PI_SESSION_ID];
		process.env.HOME = home;
		delete process.env.PI_SESSION_ID;
		const named = await run(
			unbrokered,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
			'command -v gcloud >/dev/null; echo "token:${CLOUDSDK_AUTH_ACCESS_TOKEN-unset} ${CLOUDSDK_CORE_PROJECT-unset}"; echo "settings:$CLOUDSDK_CONFIG"; ls -A "$CLOUDSDK_CONFIG"; echo listed',
			work,
		).finally(() => {
			process.env.HOME = before;
			if (session === undefined) delete process.env.PI_SESSION_ID;
			else process.env.PI_SESSION_ID = session;
		});
		expect(named).toContain(
			"pi: gcloud has no token in the sandbox: gcloud-broker isn't on this machine",
		);
		expect(named).toContain("token:unset unset");
		expect(named).toContain(`settings:${settings}\nlisted`);
		const other = await run(unbrokered, "echo plain");
		expect(other).not.toContain("pi: gcloud");
	});

	it("has a fenced session's broker start minting before its first command", () => {
		const asked: string[] = [];
		const gcloud = () => {
			asked.push("asked");
			return { reason: "still minting" };
		};
		askTheCloudAhead({ ...sandbox, gcloud });
		askTheCloudAhead({ kind: "none" });
		askTheCloudAhead({ kind: "refused", reason: "no landrun here" });
		expect(asked).toEqual(["asked"]);
	});

	it("runs nothing when the sandbox was refused, and says why", async () => {
		// A stand-in for the system's logger, which says what it was handed
		// rather than writing to the machine's real log.
		const folder = mkdtempSync(join(tmpdir(), "refusal-logger-"));
		const logger = join(folder, "logger");
		writeFileSync(logger, "#!/bin/sh\nprintf 'logged %s\\n' \"$*\" >&2\n");
		chmodSync(logger, 0o755);
		try {
			const answer = await run(
				{ kind: "refused", reason: "no landrun here", logger },
				"echo ran",
			);
			expect(answer).toContain("no landrun here");
			expect(answer).not.toMatch(/^ran$/m);
			expect(answer).toContain("126");
			expect(answer, "the refusal left no line in the log").toMatch(
				/logged -t pi-fence -p auth\.notice -- refused kind=program tool=bash /,
			);
			expect(answer, "the log was handed the command").not.toMatch(
				/logged .*echo ran/,
			);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("says so when a refused command's log didn't take it", async () => {
		const answer = await run(
			{ kind: "refused", reason: "no landrun here" },
			"echo ran",
		);
		expect(answer, "a refusal with no logger hid it").toContain(
			"The system log didn't take this refusal.",
		);
	});
});

describe.skipIf(!systemProgram("landrun") || process.platform !== "linux")(
	"a command under landrun itself",
	() => {
		let work: string;
		let elsewhere: string;
		let shared: string;
		let fixture: string;
		const landrun = systemProgram("landrun") ?? "";

		/** git on the fixture alone, without the person's own settings. */
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, {
				cwd,
				env: {
					...process.env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_AUTHOR_NAME: "fixture",
					GIT_AUTHOR_EMAIL: "fixture@example.invalid",
					GIT_COMMITTER_NAME: "fixture",
					GIT_COMMITTER_EMAIL: "fixture@example.invalid",
				},
			});

		beforeAll(() => {
			work = mkdtempSync(join(tmpdir(), "sandbox-work-"));
			// Outside every folder the profile names: not the home folder's
			// settings, the work, a temporary folder or the cache.
			elsewhere = mkdtempSync("/var/tmp/sandbox-kept-out-");
			writeFileSync(join(elsewhere, "token"), "the-hidden-value");
			// /tmp, which other sessions share and run scripts from.
			shared = mkdtempSync("/tmp/sandbox-shared-");
			writeFileSync(join(shared, "script"), "the-shared-value");
			// A repository and a worktree of it, as the work tool cuts one.
			fixture = mkdtempSync(join(tmpdir(), "sandbox-git-"));
			git(fixture, "init", "-q", "repo");
			git(
				join(fixture, "repo"),
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"fixture-commit",
			);
			git(
				join(fixture, "repo"),
				"worktree",
				"add",
				"-q",
				"--detach",
				"../tree",
			);
		});

		afterAll(() => {
			rmSync(work, { recursive: true, force: true });
			rmSync(elsewhere, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
			rmSync(fixture, { recursive: true, force: true });
		});

		it("reads its worktree's history, and can't write the repository's hooks", async () => {
			const hooks = join(fixture, "repo/.git/hooks");
			const answer = await run(
				{ kind: "strict", landrun },
				`git log --format=%s -1; echo x > ${hooks}/post-checkout || echo unhooked`,
				join(fixture, "tree"),
			);
			expect(answer).toContain("fixture-commit");
			expect(answer).toContain("unhooked");
		});

		it("writes its work, and can't read what the profile leaves out", async () => {
			const answer = await run(
				{ kind: "strict", landrun },
				`echo made > made && cat made; cat ${elsewhere}/token || echo refused`,
				work,
			);
			expect(answer).toContain("made");
			expect(answer).not.toContain("the-hidden-value");
			expect(answer).toContain("refused");
		});

		it("can't read a token from its environment or its parent's", async () => {
			process.env.SANDBOX_TEST_TOKEN = "the-token-value";
			const answer = await run(
				{ kind: "strict", landrun },
				// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
				'echo "own:${SANDBOX_TEST_TOKEN-none}"; tr "\\0" "\\n" < /proc/$PPID/environ || echo parent-unread',
				work,
			).finally(() => {
				delete process.env.SANDBOX_TEST_TOKEN;
			});
			expect(answer).toContain("own:none");
			expect(answer).toContain("parent-unread");
			expect(answer).not.toContain("the-token-value");
		});

		it("neither reads nor writes /tmp, and has a temporary folder of its own", async () => {
			const answer = await run(
				{ kind: "strict", landrun },
				`cat ${shared}/script || echo unread; echo x > ${shared}/planted || echo unwritten; mktemp && echo made-own`,
				work,
			);
			expect(answer).not.toContain("the-shared-value");
			expect(answer).toContain("unread");
			expect(answer).toContain("unwritten");
			expect(answer).toContain(sandboxFolders(homedir()).temporary);
			expect(answer).toContain("made-own");
		});
	},
);

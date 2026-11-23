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

import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEMP_LINK_PREFIX as QUESTS_LINK_PREFIX } from "../../../extensions/quest-workflow/scratch.ts";
import { agentBash } from "../../../extensions/shell-workflow/agent-bash.ts";
import {
	direnvTrusts,
	makeShares,
	questScratch,
	questShare,
	TEMP_LINK_PREFIX,
} from "../../../lib/internal/sandbox/quest-folders.ts";
import {
	askTheCloudAhead,
	type Sandbox,
	sandboxFor,
	wrapFor,
} from "../../../lib/internal/sandbox/sandbox.ts";
import { quoted } from "../../../lib/internal/sandbox/sandbox-shell.ts";
import {
	NIX_DOOR,
	sandboxFolders,
} from "../../../lib/internal/sandbox/strict-rules.ts";
import { systemProgram } from "../../../lib/internal/sandbox/system-program.ts";
import { worktreeRepository } from "../../../lib/internal/sandbox/tree-git.ts";

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
 * runs in a folder of its own in the temporary folder unless told
 * otherwise, not the folder the tests started in: the strict sandbox
 * refuses a plain clone's, which holds its git folder, so the tests would
 * fail wherever they're checked out so; nor the temporary folder itself,
 * which holds the tests' runtime folder, one the fence hides.
 */
async function run(
	sandbox: Sandbox,
	command: string,
	cwd = mkdtempSync(join(tmpdir(), "sandbox-run-")),
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

	it("runs nothing where Linux lacks the sandbox's program", () => {
		expect(
			sandboxFor({ PI_SANDBOX: "strict" }, "linux", () => undefined).kind,
		).toBe("refused");
	});

	const onMac = (
		asked: "strict" | "fence",
		inside: boolean,
		sandboxExec: string | undefined,
		platform: NodeJS.Platform = "darwin",
	) =>
		sandboxFor(
			{ PI_SANDBOX: asked },
			platform,
			found,
			undefined,
			undefined,
			undefined,
			() => inside,
			() => sandboxExec,
		);
	const strictOnMac = (inside: boolean) => onMac("strict", inside, undefined);

	it("runs a strict session's commands on a Mac as they are inside the sandbox pi runs in, saying so, since Landlock is Linux's", () => {
		const mac = strictOnMac(true);
		expect(mac.kind, "a Mac's strict session ran nothing").toBe("none");
		const note = mac.kind === "none" ? mac.note : undefined;
		expect(note, "the session wasn't told its commands run unfenced").toMatch(
			/strict fence.*as they are/,
		);
		expect(
			mac.kind === "none" && mac.asked,
			"its host would be told none, and the node could carry it back unfenced",
		).toBe("strict");
	});

	it("holds a session's credentials back from a strict command on a Mac, keeping what it runs with and how it ended", () => {
		// Without landrun to pass only the names it keeps, a Mac's strict
		// command once read every token the session held (ISXEG8, 23 November).
		const wrap = wrapFor(
			strictOnMac(true),
			{ cwd: tmpdir(), env: {} },
			homedir(),
		);
		expect(
			wrap,
			"a Mac's strict command ran with no wrap at all",
		).toBeDefined();
		// The third line is what the command's own shell was started with,
		// which a Mac lets a process of the same user read (`ps -E`), so a
		// name unset after the start would still be read there. Linux says
		// it in /proc; a Mac only through ps, which prints the command and
		// then its environment, so there each name is looked for with its
		// `=`.
		const command = `printf '%s\\n' "it's \\"said\\""; /usr/bin/env | cut -d= -f1 | sort | tr '\\n' ' '; echo; if [ -r /proc/$$/environ ]; then tr '\\0' '\\n' < /proc/$$/environ | cut -d= -f1 | tr '\\n' ' '; else ps -wwE -o command= -p $$ | tr '\\n' ' '; fi; echo; printf '%s\\n' "$XDG_RUNTIME_DIR"; exit 3`;
		const lab = mkdtempSync(join(tmpdir(), "held-back-"));
		const sourced = join(lab, "sourced");
		const startup = join(lab, "startup.sh");
		// The shell around the command reads it, as pi's own does; only the
		// command's shell, started with the command in a variable, mustn't.
		writeFileSync(
			startup,
			`[ -z "\${PI_SANDBOXED_COMMAND+set}" ] || echo sourced > '${sourced}'\n`,
		);
		// An env ahead on PATH that tells on itself: the hold-back must
		// name the system's, or this one is handed every token.
		const stray = join(lab, "bin");
		mkdirSync(stray);
		writeFileSync(
			join(stray, "env"),
			`#!/bin/sh\necho stray > '${join(lab, "stray")}'\nexit 99\n`,
		);
		chmodSync(join(stray, "env"), 0o755);
		// No stdin: bash on a socket takes itself for a remote shell and
		// reads the system's settings, which put PATH back without the stray.
		const ran = spawnSync("bash", ["-c", wrap?.(command) ?? ""], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: `${stray}:${process.env.PATH ?? ""}`,
				HOME: homedir(),
				LANG: "C",
				TMPDIR: tmpdir(),
				XDG_RUNTIME_DIR: "/run/user/1 with a space",
				GH_TOKEN: "held",
				SSH_AUTH_SOCK: "/held.sock",
				VENDOR_LOGIN: "held",
				CONFIG_PASSWORD_DIR: "held",
				BASH_ENV: startup,
				"BASH_FUNC_leaked%%": "() { :; }",
			},
		});
		const ended = ran.status;
		const [said, names = "", started = "", spaced = ""] =
			ran.stdout.split("\n");
		expect(
			existsSync(join(lab, "stray")),
			"an env ahead on PATH was handed the session's environment",
		).toBe(false);
		expect(
			existsSync(sourced),
			"the session's BASH_ENV ran in the command's shell",
		).toBe(false);
		rmSync(lab, { recursive: true, force: true });
		expect(said, "the command's own quoting didn't survive").toBe(
			`it's "said"`,
		);
		expect(spaced, "a kept value lost its space").toBe(
			"/run/user/1 with a space",
		);
		expect(ended, "the command's exit status was lost").toBe(3);
		expect(
			started.trim(),
			"nothing said what the command's shell started with",
		).not.toBe("");
		const startedNames = started.includes("=")
			? started
			: started
					.trim()
					.split(" ")
					.map((name) => `${name}=`)
					.join(" ");
		const seen = names.trim().split(" ");
		for (const held of [
			"GH_TOKEN",
			"SSH_AUTH_SOCK",
			"VENDOR_LOGIN",
			"CONFIG_PASSWORD_DIR",
			"PI_SANDBOXED_COMMAND",
			"BASH_ENV",
			"BASH_FUNC_leaked%%",
		]) {
			expect(seen, `${held} reached the command`).not.toContain(held);
			// The command itself travels in at the start, as through landrun.
			if (held !== "PI_SANDBOXED_COMMAND") {
				expect(
					startedNames,
					`${held} was in what the command's shell started with`,
				).not.toContain(`${held}=`);
			}
		}
		for (const kept of ["PATH", "HOME", "LANG", "TMPDIR", "XDG_RUNTIME_DIR"]) {
			expect(seen, `${kept} was taken from the command`).toContain(kept);
		}
	});

	it("leaves what a queue runs after a Mac's strict command its environment", () => {
		const wrap = wrapFor(
			strictOnMac(true),
			{ cwd: tmpdir(), env: {} },
			homedir(),
		);
		const after = execFileSync(
			"bash",
			["-c", `${wrap?.("printf 'ran '") ?? ""}\nprintf %s "$GH_TOKEN"`],
			{ encoding: "utf8", env: { PATH: process.env.PATH, GH_TOKEN: "kept" } },
		);
		expect(
			after,
			"the command didn't run, or the shell around it lost its variables",
		).toBe("ran kept");
	});

	it("runs none of a strict session's commands on a Mac where nothing fences pi and sandbox-exec is missing, since a stranger's text would run as the person", () => {
		expect(strictOnMac(false).kind).toBe("refused");
	});

	it("lays the fence asked for around each command on a Mac where nothing fences pi, so a bare pi runs its commands fenced rather than none at all", () => {
		for (const asked of ["strict", "fence"] as const) {
			const mac = onMac(asked, false, "/usr/bin/sandbox-exec");
			expect(mac, `a bare Mac pi's ${asked} session laid no fence`).toEqual({
				kind: "seatbelt",
				asked,
				sandboxExec: "/usr/bin/sandbox-exec",
				logger: "/bin/landrun",
			});
		}
		expect(
			onMac("strict", true, "/usr/bin/sandbox-exec").kind,
			"a pi inside a sandbox laid a second profile, which macOS refuses",
		).toBe("none");
		expect(
			onMac("strict", false, "/usr/bin/sandbox-exec", "freebsd").kind,
			"a system with no seatbelt was handed one",
		).toBe("refused");
	});

	it("runs nothing when the one wrap asked of a Mac's own fence isn't the one that lays it", () => {
		const wrap = wrapFor(
			onMac("strict", false, "/usr/bin/sandbox-exec"),
			{ cwd: tmpdir(), env: {} },
			homedir(),
		);
		const ran = spawnSync("bash", ["-c", wrap?.("echo ran") ?? "echo ran"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH },
		});
		expect(ran.stdout, "the command ran unfenced").not.toContain("ran");
		expect(ran.status, "the refusal's status wasn't the fence's").toBe(126);
	});

	it("reads a name it doesn't know as the fence, saying so once", () => {
		const loose = sandboxFor({ PI_SANDBOX: "loose" }, "linux", found);
		expect(loose.kind, "an unknown name wasn't fenced").toBe("fence");
		const note = loose.kind === "fence" ? loose.note : undefined;
		expect(note, "the note doesn't say the way back").toContain(
			"PI_SANDBOX=off",
		);
	});
});

// What unfencedFolder refuses is proved in unfenced-folder.test.ts.
describe("a working folder the sandbox won't let commands write", () => {
	let home: string;

	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), "sandbox-home-"));
		mkdirSync(join(home, "checkout/.git"), { recursive: true });
		mkdirSync(join(home, "worktree"));
		writeFileSync(join(home, "worktree/.git"), "gitdir: elsewhere\n");
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

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
	it("is the quest its TMPDIR's link names, and none elsewhere", () => {
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

	it("is the quest its TMPDIR names, wherever a command has pointed its link since", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-scratch-")));
		const root = join(base, "quest-workspace");
		mkdirSync(join(root, "QEST-1/tmp"), { recursive: true });
		mkdirSync(join(root, "QEST-2/tmp"), { recursive: true });
		// The link lies in /tmp, which a fenced command writes: swapped for
		// one into another quest's scratch, it would lead the fence there.
		const link = join(base, "pi-quest-QEST-1");
		symlinkSync(join(root, "QEST-2/tmp"), link);
		try {
			expect(questScratch(link, root)).toEqual({
				root,
				own: join(root, "QEST-1"),
			});
			expect(
				questScratch(join(root, "QEST-2/tmp"), root),
				"a TMPDIR in the scratches as written",
			).toEqual({ root, own: join(root, "QEST-2") });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("is the quest its TMPDIR names under scratches reached through a link", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-scratch-")));
		mkdirSync(join(base, "cache/quest-workspace/QEST-1/tmp"), {
			recursive: true,
		});
		// As where the cache is a link, and the quest workflow, with no link
		// in /tmp made, hands out the scratch's tmp as written.
		symlinkSync(join(base, "cache"), join(base, "linked"));
		const root = join(base, "linked/quest-workspace");
		try {
			expect(questScratch(join(root, "QEST-1/tmp"), root)).toEqual({
				root: join(base, "cache/quest-workspace"),
				own: join(base, "cache/quest-workspace/QEST-1"),
			});
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reads the quest's link by the name the quest workflow gives it", () => {
		expect(TEMP_LINK_PREFIX).toBe(QUESTS_LINK_PREFIX);
	});

	it("is none where the quest's own scratch is a link, or not there", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-scratch-")));
		const root = join(base, "quest-workspace");
		mkdirSync(join(root, "QEST-2/tmp"), { recursive: true });
		symlinkSync(join(root, "QEST-2"), join(root, "QEST-1"));
		try {
			expect(questScratch(join(base, "pi-quest-QEST-1"), root)).toEqual({
				root,
			});
			expect(
				questScratch(join(root, "QEST-1/tmp"), root),
				"through the link, as written",
			).toEqual({ root });
			expect(questScratch(join(base, "pi-quest-QEST-3"), root)).toEqual({
				root,
			});
			expect(questScratch(join(base, "pi-quest-.."), root)).toEqual({
				root,
			});
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("a session's quest shared folder", () => {
	it("is made with its root, named as its scratch is, and only the root without a scratch", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-share-")));
		const root = join(base, "quest-shares");
		try {
			expect(makeShares({}, root), "no quest, no own folder").toEqual({
				root,
			});
			expect(lstatSync(root).isDirectory(), "the root made all the same").toBe(
				true,
			);
			expect(statSync(root).mode & 0o777, "the root its owner's alone").toBe(
				0o700,
			);
			expect(
				makeShares({ own: join(base, "quest-workspace", "QEST-1") }, root),
			).toEqual({ root, own: join(root, "QEST-1") });
			expect(statSync(join(root, "QEST-1")).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("takes no own folder under a root that is a link, as one into the scratches", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-share-")));
		const scratches = join(base, "quest-workspace");
		mkdirSync(scratches, { recursive: true });
		const root = join(base, "quest-shares");
		symlinkSync(scratches, root);
		try {
			const scratch = { own: join(scratches, "QEST-1") };
			expect(questShare(scratch, root)).toEqual({ root });
			expect(makeShares(scratch, root)).toEqual({ root });
			expect(readdirSync(scratches), "nor made through it").toEqual([]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("is made before a command of any sandbox, so a quest shares unfenced too", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-share-")));
		vi.stubEnv("XDG_CACHE_HOME", join(base, "cache"));
		try {
			const own = join(questScratch(undefined).root, "QEST-20261021-LUQ49E");
			mkdirSync(join(own, "tmp"), { recursive: true });
			expect(
				wrapFor(
					{ kind: "none" },
					{ cwd: base, env: { TMPDIR: join(own, "tmp") } },
					base,
				),
			).toBeUndefined();
			expect(readdirSync(questShare({}).root)).toEqual([
				"QEST-20261021-LUQ49E",
			]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("is bound into a fenced command writable for its own quest and read-only for every other", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-share-")));
		vi.stubEnv("XDG_CACHE_HOME", join(base, "cache"));
		try {
			const quest = "QEST-20261021-LUQ49E";
			const own = join(questScratch(undefined).root, quest);
			mkdirSync(join(own, "tmp"), { recursive: true });
			const command =
				wrapFor(
					{ kind: "fence", bwrap: "bwrap", landrun: "landrun" },
					{ cwd: base, env: { TMPDIR: join(own, "tmp") } },
					base,
				)?.("true") ?? "";
			const root = questShare({}).root;
			const bound = (...words: string[]) => words.map(quoted).join(" ");
			expect(command, "every quest's read-only").toContain(
				bound("--ro-bind", root, root),
			);
			expect(command, "its own writable").toContain(
				bound("--bind", join(root, quest), join(root, quest)),
			);
		} finally {
			vi.unstubAllEnvs();
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("lies outside every folder a fenced direnv trusts, as direnv matches a plain prefix", () => {
		const shares = questShare({}).root;
		const trusted = direnvTrusts();
		expect(trusted.length).toBeGreaterThan(0);
		for (const prefix of trusted) {
			expect(shares.startsWith(prefix), prefix).toBe(false);
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
				// A Mac has no /proc, so there the shell's arguments are read with ps.
				'{ tr "\\0" " " < /proc/$$/cmdline || ps -o args= -p $$; } 2>/dev/null; echo',
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

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

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBash } from "../../../extensions/shell-workflow/agent-bash.ts";
import {
	NIX_DOOR,
	onPath,
	type Sandbox,
	sandboxFolders,
	sandboxFor,
	strictRules,
	unfencedFolder,
} from "../../../extensions/shell-workflow/sandbox.ts";

/** Run a command as a session with `sandbox` would; its text and exit. */
async function run(
	sandbox: Sandbox,
	command: string,
	cwd = process.cwd(),
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
		expect(sandboxFor({ PI_SANDBOX: "strict" }, "linux", found)).toEqual({
			kind: "strict",
			landrun: "/bin/landrun",
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
		expect(answer).toContain("worktree");
		expect(answer).not.toMatch(/^ran$/m);
	});
});

describe("a command in the sandbox", () => {
	let folder: string;
	let sandbox: Sandbox;

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

	it("keeps the person's variables, less the bus, and points Nix and the cache at its own", async () => {
		const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
		process.env.SANDBOX_TEST_KEPT = "kept";
		process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
		const answer = await run(
			sandbox,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
			'echo "$SANDBOX_TEST_KEPT ${DBUS_SESSION_BUS_ADDRESS-nobus} $NIX_REMOTE"; echo "own:$XDG_CACHE_HOME $TMPDIR"',
		).finally(() => {
			delete process.env.SANDBOX_TEST_KEPT;
			if (bus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
			else process.env.DBUS_SESSION_BUS_ADDRESS = bus;
		});
		const runtime = process.env.XDG_RUNTIME_DIR;
		expect(answer).toContain(
			`kept nobus ${runtime ? `unix://${runtime}/${NIX_DOOR}` : ""}`.trim(),
		);
		const own = sandboxFolders(homedir());
		expect(answer).toContain(`own:${own.cache} ${own.temporary}`);
	});

	it("runs nothing when the sandbox was refused, and says why", async () => {
		const answer = await run(
			{ kind: "refused", reason: "no landrun here" },
			"echo ran",
		);
		expect(answer).toContain("no landrun here");
		expect(answer).not.toMatch(/^ran$/m);
		expect(answer).toContain("126");
	});
});

describe.skipIf(!onPath("landrun") || process.platform !== "linux")(
	"a command under landrun itself",
	() => {
		let work: string;
		let elsewhere: string;
		let shared: string;
		const landrun = onPath("landrun") ?? "";

		beforeAll(() => {
			work = mkdtempSync(join(tmpdir(), "sandbox-work-"));
			// Outside every folder the profile names: not the home folder's
			// settings, the work, a temporary folder or the cache.
			elsewhere = mkdtempSync("/var/tmp/sandbox-kept-out-");
			writeFileSync(join(elsewhere, "token"), "the-hidden-value");
			// /tmp, which other sessions share and run scripts from.
			shared = mkdtempSync("/tmp/sandbox-shared-");
			writeFileSync(join(shared, "script"), "the-shared-value");
		});

		afterAll(() => {
			rmSync(work, { recursive: true, force: true });
			rmSync(elsewhere, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
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

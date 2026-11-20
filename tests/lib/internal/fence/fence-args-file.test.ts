/**
 * bubblewrap's arguments read from a file (`fence-args-file.ts`), so a
 * fenced command starts however many trees its session holds: through
 * a stand-in bubblewrap that reads `--args` as the real one does, with
 * the command's text in a variable as pi's shell hands it on, and a
 * full environment beside it.
 */

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bwrapArgsFile } from "../../../../lib/internal/fence/fence-args-file.ts";
import { fencedCommand } from "../../../../lib/internal/fence/fence-command.ts";
import { wrapFor } from "../../../../lib/internal/sandbox/sandbox.ts";

/** The trees a session holds in the red case, past any machine's count. */
const TREES = 3_000;

/** The longest one string Linux passes a program (MAX_ARG_STRLEN). */
const LONGEST_STRING = 128 * 1024;

/**
 * bubblewrap's arguments for `trees` held trees, shaped as the fence
 * gives each one: the tree and its git folder bound back writable, and
 * its `.git` file and git settings read-only over them.
 */
function heldTreeArgs(trees: number): string[] {
	const root = "/home/someone/.local/state/pi/agentic-harness.pi/work/trees";
	const git = "/home/someone/src/agentic-harness.pi/.git/worktrees";
	return Array.from({ length: trees }, (_, at) => {
		const name = `worktree-github-Someone-agentic-harness.pi-someone-branch-${at}`;
		const tree = join(root, name);
		const folder = join(git, name);
		return [
			["--bind", tree, tree],
			["--bind", folder, folder],
			...[
				join(tree, ".git"),
				join(folder, "commondir"),
				join(folder, "gitdir"),
				join(folder, "config.worktree"),
			].map((path) => ["--ro-bind", path, path]),
		].flat();
	}).flat();
}

describe("bubblewrap's arguments from a file", () => {
	let folder: string;
	let runtimeDir: string;
	let bwrap: string;
	let landrun: string;

	beforeAll(() => {
		folder = realpathSync(mkdtempSync(join(tmpdir(), "fence-args-")));
		runtimeDir = join(folder, "run");
		mkdirSync(runtimeDir);
		// Reads `--args` from its descriptor as bubblewrap does, says how many
		// it read, and runs what follows the first `--`.
		bwrap = join(folder, "bwrap");
		writeFileSync(
			bwrap,
			[
				"#!/usr/bin/env bash",
				"read=0",
				'while [ "$1" != -- ]; do',
				'  if [ "$1" = --args ]; then',
				'    mapfile -d "" -t from <&"$2"',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
				"    read=${#from[@]}",
				"    shift 2",
				"  else shift; fi",
				"done",
				"shift",
				'echo "read $read"',
				'exec "$@"',
			].join("\n"),
			{ mode: 0o755 },
		);
		// Runs what follows the second `--`, past its own rules.
		landrun = join(folder, "landrun");
		writeFileSync(
			landrun,
			[
				"#!/usr/bin/env bash",
				'while [ "$1" != -- ]; do shift; done',
				"shift",
				'exec "$@"',
			].join("\n"),
			{ mode: 0o755 },
		);
	});

	afterAll(() => {
		rmSync(folder, { recursive: true, force: true });
	});

	/**
	 * Runs `text` as pi's shell does, from a variable rather than its
	 * command line, with an environment of some 20 KB beside it.
	 */
	function runAsTheShell(text: string) {
		const environment: Record<string, string> = {
			PATH: process.env.PATH ?? "",
			PI_FENCED_TEXT: text,
		};
		for (let at = 0; at < 100; at += 1) {
			environment[`SOME_SETTING_${at}`] = "x".repeat(200);
		}
		return spawnSync("bash", ["-c", 'eval "$PI_FENCED_TEXT"'], {
			cwd: folder,
			env: environment,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	it(`starts a command whose session holds ${TREES} trees`, () => {
		const args = heldTreeArgs(TREES);
		const argsFile = bwrapArgsFile(runtimeDir, args);
		expect(argsFile, "no file was written").toBeDefined();
		const text = fencedCommand("echo inside", {
			bwrap,
			landrun,
			args,
			...(argsFile ? { argsFile } : {}),
			rules: [],
		});
		expect(
			Buffer.byteLength(text),
			"the text passes what Linux takes in one string",
		).toBeLessThan(LONGEST_STRING / 8);
		const ran = runAsTheShell(text);
		expect(ran.error?.message ?? "", "it couldn't start").toBe("");
		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout).toBe(`read ${args.length}\ninside\n`);
	});

	it("holds each argument ended by a NUL, in one file for the same arguments", () => {
		const args = ["--ro-bind", "/a b", "/a b", "--dev", "/dev"];
		const first = bwrapArgsFile(runtimeDir, args);
		const again = bwrapArgsFile(runtimeDir, args);
		const other = bwrapArgsFile(runtimeDir, [...args, "--proc", "/proc"]);
		expect(first).toBeDefined();
		expect(again, "the same arguments took another file").toBe(first);
		expect(other, "other arguments shared a file").not.toBe(first);
		expect(readFileSync(first ?? "", "utf8")).toBe(
			"--ro-bind\0/a b\0/a b\0--dev\0/dev\0",
		);
	});

	it("gives no file without a runtime folder, or for an argument holding a NUL", () => {
		expect(bwrapArgsFile(undefined, ["--dev", "/dev"])).toBeUndefined();
		expect(
			bwrapArgsFile(runtimeDir, ["--bind", "/a\0b", "/a"]),
		).toBeUndefined();
	});

	it("removes the files nothing used for a day, and keeps one in use", () => {
		const day = 24 * 60 * 60_000;
		const kept = bwrapArgsFile(runtimeDir, ["--kept"]) ?? "";
		const stale = bwrapArgsFile(runtimeDir, ["--stale"]) ?? "";
		const old = new Date(Date.now() - 2 * day);
		utimesSync(stale, old, old);
		utimesSync(kept, old, old);
		// An hour on, so this process looks again, and the kept one is used.
		bwrapArgsFile(runtimeDir, ["--kept"], () => Date.now() + 2 * 60 * 60_000);
		const left = readdirSync(join(runtimeDir, "pi-fence"));
		expect(left, "the stale file stayed").not.toContain(stale.split("/").pop());
		expect(left, "the file in use was removed").toContain(
			kept.split("/").pop(),
		);
	});

	it("is how a fenced session's command reads them, when there is a runtime folder", () => {
		const home = join(folder, "home");
		mkdirSync(home, { recursive: true });
		const text =
			wrapFor(
				{ kind: "fence", bwrap: "bwrap", landrun: "landrun" },
				{ cwd: home, env: { XDG_RUNTIME_DIR: runtimeDir } },
				home,
			)?.("true") ?? "";
		const file = /--args 3 3<'([^']+)'/.exec(text)?.[1];
		expect(file, "the text passed its arguments itself").toBeDefined();
		expect(text, "a bind was left in the text").not.toContain("'--ro-bind'");
		const args = readFileSync(file ?? "", "utf8").split("\0");
		expect(args, "the home folder isn't bound").toContain(home);
	});
});

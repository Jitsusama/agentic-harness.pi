/**
 * bubblewrap's arguments read from a file (`fence-args-file.ts`), so a
 * fenced command starts however many trees its session holds: through
 * a stand-in bubblewrap that reads `--args` as the real one does, with
 * the command's text in a variable as pi's shell hands it on, and a
 * full environment beside it.
 */

import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	onTestFinished,
} from "vitest";
import {
	BWRAP_MOST_ARGS,
	bwrapArgsFile,
	guardedListFile,
} from "../../../../lib/internal/fence/fence-args-file.ts";
import {
	bwrapWords,
	fencedCommand,
} from "../../../../lib/internal/fence/fence-command.ts";
import { wrapFor } from "../../../../lib/internal/sandbox/sandbox.ts";

/**
 * The trees a session holds in the red case: their arguments run far
 * past what Linux takes in one string, and stay within what bubblewrap
 * takes.
 */
const TREES = 400;

/** The longest one string Linux passes a program (MAX_ARG_STRLEN). */
const LONGEST_STRING = 128 * 1024;
/** The longest path a Unix socket may have on Linux (sun_path less its NUL). */
const SOCKET_PATH_MOST = 107;

/** Whether `folder` is there for this test to write in. */
function writable(folder: string): boolean {
	try {
		accessSync(folder, constants.W_OK);
		return true;
	} catch {
		// Not there, or not this account's to write in.
		return false;
	}
}

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
		// it read, and runs what follows the first `--`. It writes beside
		// itself how many arguments bubblewrap would count: every word after
		// its name, and those it read.
		bwrap = join(folder, "bwrap");
		writeFileSync(
			bwrap,
			[
				"#!/usr/bin/env bash",
				"words=$#",
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
				'echo "$((words + read))" > "$0.count"',
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

	it("says when the variables it passes would take bubblewrap past its count, and never starts it", () => {
		const fits = (count: number) => {
			const args = Array.from({ length: count }, () => "--unshare-ipc");
			const argsFile = bwrapArgsFile(runtimeDir, args);
			if (!argsFile) throw new Error("no file was written");
			const fence = { bwrap, landrun, args: argsFile, rules: [] };
			expect(bwrapWords(fence), "counted without the variables").toBe(
				count + 3 + 1 + 2 * 2 + 4,
			);
			return runAsTheShell(fencedCommand("echo inside", fence));
		};
		// Its hundred-odd variables are some 200 words beside the line.
		const over = fits(BWRAP_MOST_ARGS - 100);
		expect(over.status).toBe(126);
		expect(over.stdout, "bubblewrap started").toBe("");
		expect(over.stderr).toContain(`past the ${BWRAP_MOST_ARGS} it takes`);
		const under = fits(BWRAP_MOST_ARGS - 1000);
		expect(under.stderr).toBe("");
		expect(under.stdout).toBe(`read ${BWRAP_MOST_ARGS - 1000}\ninside\n`);
		// What bubblewrap would count, the variables included, places the
		// line that lands on its limit exactly, and the one a word past it.
		const counted = Number(readFileSync(`${bwrap}.count`, "utf8"));
		const atLimit = BWRAP_MOST_ARGS - 1000 + (BWRAP_MOST_ARGS - counted);
		const at = fits(atLimit);
		expect(at.stderr, "refused at the limit").toBe("");
		expect(
			Number(readFileSync(`${bwrap}.count`, "utf8")),
			"what bubblewrap counts",
		).toBe(BWRAP_MOST_ARGS);
		const past = fits(atLimit + 1);
		expect(past.status, "started a word past the limit").toBe(126);
		expect(past.stderr).toContain(
			`hand bubblewrap ${BWRAP_MOST_ARGS + 1} arguments`,
		);
	});

	it(`starts a command whose session holds ${TREES} trees`, () => {
		const args = heldTreeArgs(TREES);
		expect(args.length, "more than bubblewrap takes").toBeLessThan(
			BWRAP_MOST_ARGS,
		);
		expect(
			Buffer.byteLength(args.join(" ")),
			"no longer than Linux takes in one string",
		).toBeGreaterThan(4 * LONGEST_STRING);
		const argsFile = bwrapArgsFile(runtimeDir, args);
		expect(argsFile, "no file was written").toBeDefined();
		const text = fencedCommand("echo inside", {
			bwrap,
			landrun,
			args: argsFile ?? args,
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
		expect(first?.args).toBe(args);
		expect(again?.path, "the same arguments took another file").toBe(
			first?.path,
		);
		expect(other?.path, "other arguments shared a file").not.toBe(first?.path);
		expect(readFileSync(first?.path ?? "", "utf8")).toBe(
			"--ro-bind\0/a b\0/a b\0--dev\0/dev\0",
		);
	});

	it("gives no file without a runtime folder, or for an argument holding a NUL", () => {
		expect(bwrapArgsFile(undefined, ["--dev", "/dev"])).toBeUndefined();
		expect(
			bwrapArgsFile(runtimeDir, ["--bind", "/a\0b", "/a"]),
		).toBeUndefined();
	});

	it("removes the files nothing used for a day, and keeps one in use and the fence's other copies", () => {
		const day = 24 * 60 * 60_000;
		const kept = bwrapArgsFile(runtimeDir, ["--kept"])?.path ?? "";
		const stale = bwrapArgsFile(runtimeDir, ["--stale"])?.path ?? "";
		const staleList = guardedListFile(runtimeDir, ["/stale"]) ?? "";
		const other = join(runtimeDir, "pi-fence", "ssh_config");
		writeFileSync(other, "Host *\n");
		const old = new Date(Date.now() - 2 * day);
		for (const path of [stale, staleList, kept, other])
			utimesSync(path, old, old);
		// An hour on, so this process looks again, and the kept one is used.
		bwrapArgsFile(runtimeDir, ["--kept"], () => Date.now() + 2 * 60 * 60_000);
		const left = readdirSync(join(runtimeDir, "pi-fence"));
		const named = (path: string) => path.split("/").pop();
		expect(left, "the stale file stayed").not.toContain(named(stale));
		expect(left, "the stale list stayed").not.toContain(named(staleList));
		expect(left, "the file in use was removed").toContain(named(kept));
		expect(left, "another of the fence's copies was removed").toContain(
			"ssh_config",
		);
	});

	it("sweeps each runtime folder in its own hour, though another was swept a minute before", () => {
		const folders = ["run-one", "run-two"].map((name) => {
			const made = join(folder, name);
			mkdirSync(made);
			return made;
		});
		const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
		const stale = folders.map((made) => {
			const path = bwrapArgsFile(made, ["--stale", made])?.path ?? "";
			utimesSync(path, old, old);
			return path;
		});
		const later = Date.now() + 2 * 60 * 60_000;
		folders.forEach((made, at) => {
			bwrapArgsFile(made, ["--used"], () => later + at * 60_000);
		});
		folders.forEach((made, at) => {
			expect(
				readdirSync(join(made, "pi-fence")),
				`${made}'s stale file stayed`,
			).not.toContain(stale[at]?.split("/").pop());
		});
	});

	it("closes the file before the command inside runs, though a bubblewrap left it open", () => {
		const argsFile = bwrapArgsFile(runtimeDir, ["--dev", "/dev"]);
		if (!argsFile) throw new Error("no file was written");
		const ran = runAsTheShell(
			fencedCommand("[ -e /proc/$$/fd/3 ] && echo held || echo free", {
				bwrap,
				landrun,
				args: argsFile,
				rules: [],
			}),
		);
		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout, "descriptor 3 reached the command").toBe(
			"read 2\nfree\n",
		);
	});

	it("closes the file before the GitHub door's relay starts inside", async (context) => {
		const argsFile = bwrapArgsFile(runtimeDir, ["--dev", "/dev"]);
		if (!argsFile) throw new Error("no file was written");
		// A socket's path may be at most 107 bytes, which a test's own
		// temporary folder can pass: the shortest folder there is serves.
		const shortest = [tmpdir(), process.env.XDG_RUNTIME_DIR, "/dev/shm"]
			.filter((place): place is string => place !== undefined)
			.filter(writable)
			.sort((a, b) => a.length - b.length)[0];
		if (shortest === undefined) throw new Error("no folder to write in");
		const doorFolder = mkdtempSync(join(shortest, "fa-"));
		onTestFinished(() => rmSync(doorFolder, { recursive: true, force: true }));
		if (Buffer.byteLength(join(doorFolder, "door.sock")) > SOCKET_PATH_MOST)
			context.skip("no folder here is short enough for the door's socket");
		writeFileSync(join(doorFolder, "bundle.pem"), "");
		const seen = join(folder, "relay-saw");
		// Says whether it holds descriptor 3 when it starts as the relay.
		const program = join(folder, "door-program");
		writeFileSync(
			program,
			[
				"#!/usr/bin/env bash",
				'[ "$1" = relay ] || exit 0',
				`[ -e /proc/$$/fd/3 ] && echo held > '${seen}' || echo free > '${seen}'`,
				"echo 4242",
			].join("\n"),
			{ mode: 0o755 },
		);
		const socket = createServer();
		await new Promise<void>((listening, failed) => {
			socket.once("error", failed);
			socket.listen(join(doorFolder, "door.sock"), listening);
		});
		try {
			const ran = runAsTheShell(
				fencedCommand("true", {
					bwrap,
					landrun,
					args: argsFile,
					rules: [],
					github: { program, session: "s", folder: doorFolder },
				}),
			);
			expect(ran.status, ran.stderr).toBe(0);
			expect(readFileSync(seen, "utf8"), "the relay held descriptor 3").toBe(
				"free\n",
			);
		} finally {
			socket.close();
		}
	});

	it("never leaves the command inside holding the file, run by the real bubblewrap", (context) => {
		const real = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]);
		if (real.status !== 0) context.skip("bubblewrap can't run here");
		const argsFile = bwrapArgsFile(runtimeDir, [
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
		]);
		if (!argsFile) throw new Error("no file was written");
		// The shell's own test, since a program listing the folder opens a
		// descriptor of its own to read it.
		const text = fencedCommand(
			"[ -e /proc/$$/fd/3 ] && echo held || echo free",
			{
				bwrap: "bwrap",
				landrun,
				args: argsFile,
				rules: [],
			},
		);
		const ran = runAsTheShell(text);
		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout, "descriptor 3 reached the command").toBe("free\n");
	});

	it("refuses a text too long to start, blaming the command for its own length, runtime folder or not", () => {
		const home = join(folder, "home");
		mkdirSync(home, { recursive: true });
		const long = `echo ${"x".repeat(LONGEST_STRING)}`;
		const wrapped = (env: Record<string, string>) =>
			wrapFor(
				{ kind: "fence", bwrap: "bwrap", landrun: "landrun" },
				{ cwd: home, env },
				home,
			)?.(long) ?? "";
		const own = wrapped({ XDG_RUNTIME_DIR: runtimeDir });
		expect(own.length, "the long text went through").toBeLessThan(
			LONGEST_STRING,
		);
		expect(own).toContain("put it in a script and run that");
		const noFolder = wrapped({});
		expect(noFolder.length, "the long text went through").toBeLessThan(
			LONGEST_STRING,
		);
		expect(
			noFolder,
			"the runtime folder blamed for the command's own length",
		).not.toContain("XDG_RUNTIME_DIR");
		expect(noFolder).toContain("put it in a script and run that");
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

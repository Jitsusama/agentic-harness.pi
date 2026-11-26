/**
 * Removing a tree never deletes what a link swapped into it names.
 *
 * The race is the one a fenced process can run against pi: while pi
 * removes a folder it can still write, it watches a subfolder, and once
 * the walk is inside it, moves it aside and puts a link to a folder
 * outside in its place. Node's `fs.promises.rm` walks by path, so every
 * name it unlinks after the swap is the outside folder's: it is led out
 * every round (the control). `removeTree` and `removeTreeOff` walk by
 * descriptor through the system's `rm` and never are.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	firstLines,
	removerFolders,
	removeTree,
	removeTreeOff,
	systemRmCommand,
	tidyTree,
	writableArgs,
	writableArgsAfter,
} from "../../../../lib/internal/files/remove-tree.ts";
import {
	systemFolders,
	systemProgram,
} from "../../../../lib/internal/sandbox/system-program.ts";

/** Root writes where its folders' modes say nobody may, so refusals don't hold. */
const notRoot = process.getuid?.() !== 0;

/** Files in the swapped folder, and in the canary it is swapped for. */
const FILES = 2000;

/** Rounds of the race each removal gets; Node's rm lost 10 of 10. */
const ROUNDS = 4;

/** Building 2,000 files a round is the cost, more so on a loaded machine. */
const RACE_TIMEOUT_MS = 60_000;

/**
 * Watches `<victim>/d0`, and at the first name gone from it swaps it for
 * a link to `canary`, once, saying `swapped`, or `missed` when the walk
 * was done first. It says `watching` before it starts, so the removal
 * starts only then. It counts by spinning rather than with `fs.watch`,
 * whose events came after coreutils' rm had finished 2,000 files.
 */
const SWAPPER = `
const fs = require("node:fs");
const [victim, canary, files] = process.argv.slice(1);
const d0 = victim + "/d0";
process.stdout.write("watching\\n");
for (;;) {
	let left;
	try {
		left = fs.readdirSync(d0).length;
	} catch {
		process.stdout.write("missed\\n");
		break;
	}
	if (left < Number(files)) {
		try {
			fs.renameSync(d0, victim + "/keep");
			fs.symlinkSync(canary, d0);
			process.stdout.write("swapped\\n");
		} catch {
			process.stdout.write("missed\\n");
		}
		break;
	}
}
setInterval(() => {}, 60_000);
`;

/** A swapper, and everything it has said. */
interface Swapper {
	process: ChildProcess;
	said: () => string;
}

let folder: string;
const swappers: ChildProcess[] = [];

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "remove-tree-"));
});

afterEach(() => {
	for (const swapper of swappers.splice(0)) swapper.kill("SIGKILL");
	removeTree(folder);
});

/** A folder holding `count` empty files, made under `at`. */
function filled(at: string, count: number): string {
	mkdirSync(at, { recursive: true });
	for (let i = 0; i < count; i++) writeFileSync(join(at, `x${i}`), "");
	return at;
}

/** A swapper watching `victim`, answered once its watch is set. */
async function race(victim: string, canary: string): Promise<Swapper> {
	const args = ["-e", SWAPPER, victim, canary, String(FILES)];
	const child = spawn(process.execPath, args, {
		stdio: ["ignore", "pipe", "inherit"],
	});
	swappers.push(child);
	let said = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		said += chunk.toString();
	});
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.once("exit", (code) => reject(new Error(`swapper ended: ${code}`)));
	});
	return { process: child, said: () => said };
}

/** How long a swapper has to say what it did once the walk is over. */
const LAST_WORD_MS = 2_000;

/**
 * Waits until `swapper` has said whether it swapped, then stops it, and
 * answers whether it did.
 */
async function swapped(swapper: Swapper): Promise<boolean> {
	const spoke = () => /swapped|missed/.test(swapper.said());
	if (!spoke()) {
		const stdout = swapper.process.stdout;
		await new Promise<void>((resolve) => {
			const heard = () => {
				if (spoke()) done();
			};
			const done = () => {
				clearTimeout(deadline);
				stdout?.off("data", heard);
				resolve();
			};
			// A deadline, not a pause: it ends the wait only for a swapper
			// that never says what it did, which the caller then reads as missed.
			const deadline = setTimeout(done, LAST_WORD_MS);
			stdout?.on("data", heard);
		});
	}
	const exited = new Promise((resolve) =>
		swapper.process.once("exit", resolve),
	);
	swapper.process.kill("SIGKILL");
	await exited;
	return swapper.said().includes("swapped");
}

/** What a race came to: the canary's files lost, and rounds swapped. */
interface Raced {
	lost: number;
	swaps: number;
}

/**
 * Races `remove` over a fresh victim each round and answers how many of
 * the canary's files went, stopping at the first round that took any, and
 * how many rounds the swap landed in.
 */
async function lostToRace(
	remove: (path: string) => Promise<void>,
): Promise<Raced> {
	const canary = filled(join(folder, "canary"), FILES);
	let swaps = 0;
	for (let round = 0; round < ROUNDS; round++) {
		const victim = join(folder, `victim-${round}`);
		filled(join(victim, "d0"), FILES);
		const swapper = await race(victim, canary);
		try {
			await remove(victim);
		} catch {
			// A swap leaves the walk a link where it expected a folder, so
			// it may fail; what counts is what it removed outside.
		}
		// Counted only once nothing swaps, so what's gone is the removal's.
		if (await swapped(swapper)) swaps += 1;
		const lost = FILES - readdirSync(canary).length;
		if (lost > 0) return { lost, swaps };
		removeTree(victim);
	}
	return { lost: 0, swaps };
}

describe("removing a tree", () => {
	it("removes files, folders and the links in them, never what they name", () => {
		const outside = filled(join(folder, "outside"), 3);
		const tree = filled(join(folder, "tree", "deep", "deeper"), 3);
		symlinkSync(outside, join(tree, "to-outside"));
		symlinkSync(join(outside, "x0"), join(folder, "tree", "to-a-file"));

		removeTree(join(folder, "tree"));

		expect(existsSync(join(folder, "tree")), "the tree is gone").toBe(false);
		expect(readdirSync(outside)).toHaveLength(3);
	});

	it("removes a link named itself, never the folder it names", () => {
		const outside = filled(join(folder, "outside"), 2);
		symlinkSync(outside, join(folder, "link"));

		removeTree(join(folder, "link"));

		expect(existsSync(join(folder, "link")), "the link is gone").toBe(false);
		expect(readdirSync(outside)).toHaveLength(2);
	});

	it("removes a file or an empty folder without an rm", () => {
		writeFileSync(join(folder, "lock"), "");
		mkdirSync(join(folder, "claim"));

		removeTree(join(folder, "lock"), []);
		removeTree(join(folder, "claim"), []);

		expect(readdirSync(folder)).toEqual([]);
	});

	it("takes nothing there as done", async () => {
		expect(() => removeTree(join(folder, "gone"))).not.toThrow();
		await expect(removeTreeOff(join(folder, "gone"))).resolves.toBeUndefined();
	});

	it("leaves a full folder in place when no rm is root's", async () => {
		const tree = filled(join(folder, "tree", "deep"), 2);
		// The test's own folder is the user's, so an rm there isn't trusted.
		writeFileSync(join(folder, "rm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

		expect(() => removeTree(join(folder, "tree"), [folder])).toThrow(
			/no rm found where only root can put one/,
		);
		await expect(removeTreeOff(join(folder, "tree"), [folder])).rejects.toThrow(
			/no rm found/,
		);
		expect(readdirSync(tree)).toHaveLength(2);
	});

	it("says why a tidy left a tree, and throws nothing", () => {
		const tree = filled(join(folder, "tree", "deep"), 2);
		writeFileSync(join(folder, "rm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

		expect(tidyTree(join(folder, "tree"), [folder])).toMatch(/no rm found/);
		expect(readdirSync(tree)).toHaveLength(2);
		expect(tidyTree(join(folder, "tree"))).toBeUndefined();
		expect(existsSync(join(folder, "tree")), "the tree is gone").toBe(false);
	});

	it.runIf(notRoot)(
		"says why rm couldn't remove a tree, in rm's words",
		async () => {
			// A folder its owner can't write keeps the tree in it: rm empties
			// the tree, then can't take the tree's own name.
			const outer = join(folder, "outer");
			const tree = join(outer, "tree");
			filled(join(tree, "d"), 1);
			chmodSync(outer, 0o555);
			try {
				expect(() => removeTree(tree)).toThrow(
					/rm couldn't remove .*tree: rm: /,
				);
				filled(join(tree, "d"), 1);
				await expect(removeTreeOff(tree)).rejects.toThrow(
					/rm couldn't remove .*tree: rm: /,
				);
			} finally {
				chmodSync(outer, 0o755);
			}
			expect(lstatSync(tree).isDirectory(), "the tree rm refused stays").toBe(
				true,
			);
		},
	);

	it("removes a tree of read-only folders, as Go's module cache makes, when asked to", async () => {
		const evenReadOnly = { evenReadOnly: true };
		for (const remove of [
			async (path: string) => removeTree(path, removerFolders(), evenReadOnly),
			(path: string) => removeTreeOff(path, removerFolders(), evenReadOnly),
		]) {
			const cache = readOnlyCache();

			await remove(cache);

			expect(existsSync(cache), `${cache} is removed`).toBe(false);
		}
	});

	// Root removes what a folder's mode refuses, so the tree would go.
	it.skipIf(process.getuid?.() === 0)(
		"leaves a tree of read-only folders, and says so, unless asked",
		async () => {
			const cache = readOnlyCache();
			try {
				expect(() => removeTree(cache)).toThrow(/Permission denied/);
				await expect(removeTreeOff(cache)).rejects.toThrow(/Permission denied/);
				expect(existsSync(join(cache, "mod@v1", "pkg")), "what won't go").toBe(
					true,
				);
			} finally {
				chmodSync(join(cache, "mod@v1", "pkg"), 0o755);
				chmodSync(join(cache, "mod@v1"), 0o755);
			}
		},
	);

	/** A cache whose module folders are read-only, as Go's are. */
	function readOnlyCache(): string {
		const cache = join(folder, "cache");
		const module = join(cache, "mod@v1", "pkg");
		filled(module, 3);
		chmodSync(module, 0o555);
		chmodSync(join(cache, "mod@v1"), 0o555);
		return cache;
	}

	it("makes nothing writable through a link swapped in for the tree", () => {
		const chmod = systemProgram("chmod", removerFolders());
		expect(chmod, "no chmod root keeps").toBeDefined();
		const cache = readOnlyCache();
		const link = join(folder, "swapped");
		symlinkSync(cache, link);
		try {
			const ran = spawnSync(chmod ?? "chmod", writableArgs(link), {
				argv0: "chmod",
				encoding: "utf8",
			});
			expect(ran.status, ran.stderr).toBe(0);
			for (const read of [
				join(cache, "mod@v1"),
				join(cache, "mod@v1", "pkg"),
			]) {
				expect(lstatSync(read).mode & 0o777, read).toBe(0o555);
			}
		} finally {
			chmodSync(join(cache, "mod@v1"), 0o755);
			chmodSync(join(cache, "mod@v1", "pkg"), 0o755);
		}
	});

	it("makes nothing writable through a link named with a slash, even read-only, either way", async () => {
		// Through the public calls, so the even-read-only branch passing chmod
		// the path as given, slash and all, rather than the link, fails here.
		const cache = readOnlyCache();
		const reads = [join(cache, "mod@v1"), join(cache, "mod@v1", "pkg")];
		const way = { evenReadOnly: true };
		const inLine = join(folder, "swapped-in-line");
		const off = join(folder, "swapped-off");
		symlinkSync(cache, inLine);
		symlinkSync(cache, off);
		try {
			removeTree(`${inLine}/`, removerFolders(), way);
			await removeTreeOff(`${off}/`, removerFolders(), way);

			expect(existsSync(inLine), "removeTree left the link").toBe(false);
			expect(existsSync(off), "removeTreeOff left the link").toBe(false);
			for (const read of reads) {
				expect(lstatSync(read).mode & 0o777, read).toBe(0o555);
			}
		} finally {
			for (const read of reads) chmodSync(read, 0o755);
		}
	});

	it("tries chmod again without -P only when it refused -P, as GNU's before 9.5 does", () => {
		const at = join(folder, "cache");
		// What coreutils 9.4's chmod says, under LC_ALL=C, to `-R -P`.
		const refused =
			"chmod: invalid option -- 'P'\nTry 'chmod --help' for more information.";

		expect(writableArgsAfter(refused, at)).toEqual(["-R", "--", "u+w", at]);
		expect(writableArgsAfter(undefined, at), "it did all").toBeUndefined();
		expect(
			writableArgsAfter("chmod: cannot access 'x': Permission denied", at),
			"another failure",
		).toBeUndefined();
	});

	it("makes the tree writable with the older arguments, through no link inside it", () => {
		const chmod = systemProgram("chmod", removerFolders());
		expect(chmod, "no chmod root keeps").toBeDefined();
		const outside = readOnlyCache();
		const tree = join(folder, "tree");
		mkdirSync(join(tree, "inner"), { recursive: true });
		symlinkSync(join(outside, "mod@v1"), join(tree, "inner", "link"));
		chmodSync(join(tree, "inner"), 0o555);
		const older = writableArgsAfter("chmod: invalid option -- 'P'", tree);
		try {
			const ran = spawnSync(chmod ?? "chmod", older ?? [], {
				argv0: "chmod",
				encoding: "utf8",
			});
			expect(ran.status, ran.stderr).toBe(0);
			expect(lstatSync(join(tree, "inner")).mode & 0o200, "inner").toBe(0o200);
			for (const read of [
				join(outside, "mod@v1"),
				join(outside, "mod@v1", "pkg"),
			]) {
				expect(lstatSync(read).mode & 0o777, read).toBe(0o555);
			}
		} finally {
			chmodSync(join(tree, "inner"), 0o755);
			chmodSync(join(outside, "mod@v1"), 0o755);
			chmodSync(join(outside, "mod@v1", "pkg"), 0o755);
		}
	});

	it("removes a link named with a trailing slash, never what it names", async () => {
		const outside = filled(join(folder, "outside"), 3);
		for (const remove of [
			async (path: string) => removeTree(path),
			removeTreeOff,
		]) {
			const link = join(folder, "link");
			symlinkSync(outside, link);

			await remove(`${link}/`);

			expect(existsSync(link), "the link is gone").toBe(false);
			expect(readdirSync(outside), "what it names").toHaveLength(3);
		}
	});

	it("keeps the first of rm's lines and counts the rest", () => {
		const said = Array.from(
			{ length: 5000 },
			(_, n) => `rm: cannot remove 'f${n}'`,
		);

		expect(firstLines(said.join("\n"))).toBe(
			"rm: cannot remove 'f0'; rm: cannot remove 'f1'; " +
				"rm: cannot remove 'f2'; and 4997 more",
		);
	});

	it("names the system's rm by a path root alone keeps, for a shell", () => {
		const rm = systemRmCommand();

		expect(rm, "an rm in the system's folders").toMatch(/^\/.*\/rm$/);
		// A runnable rm the person owns, so only the trust check can refuse it.
		writeFileSync(join(folder, "rm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		expect(systemRmCommand([folder]), "none in the user's own").toBeUndefined();
	});

	it("finds a root's rm on this machine", () => {
		// Every other case here leans on one; without it they'd all throw.
		expect(() => removeTree(filled(join(folder, "t", "u"), 1))).not.toThrow();
		expect(removerFolders()).toContain("/bin");
	});

	it("looks in the person's own profile only after the system's folders", () => {
		const [personal, system] = systemFolders();
		const folders = removerFolders();

		expect(folders.at(-1), "the person's profile last").toBe(personal);
		expect(folders.indexOf(system ?? ""), "the system's profile first").toBe(0);
	});

	it(
		"loses the race when Node's own rm walks the tree (the control)",
		async () => {
			const { lost } = await lostToRace((path) =>
				rm(path, { recursive: true, force: true }),
			);

			expect(
				lost,
				"Node's async rm no longer follows a swapped link; " +
					"the race below has no control, so find it one",
			).toBeGreaterThan(0);
		},
		RACE_TIMEOUT_MS,
	);

	it(
		"never loses the race walking by descriptor",
		async () => {
			const sync = await lostToRace(async (path) => removeTree(path));
			removeTree(join(folder, "canary"));
			const off = await lostToRace(removeTreeOff);

			// A round whose swap came after the walk proves nothing either
			// way, and a busy machine makes some, so one landing is enough.
			expect(sync.lost).toBe(0);
			expect(off.lost).toBe(0);
			expect(sync.swaps, "rounds the swap landed in").toBeGreaterThan(0);
			expect(off.swaps, "rounds the swap landed in").toBeGreaterThan(0);
		},
		RACE_TIMEOUT_MS,
	);
});

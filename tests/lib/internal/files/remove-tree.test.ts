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

import { type ChildProcess, spawn } from "node:child_process";
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
	removerFolders,
	removeTree,
	removeTreeOff,
} from "../../../../lib/internal/files/remove-tree.ts";

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
	const until = Date.now() + LAST_WORD_MS;
	while (!/swapped|missed/.test(swapper.said()) && Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 10));
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

		expect(existsSync(join(folder, "tree"))).toBe(false);
		expect(readdirSync(outside)).toHaveLength(3);
	});

	it("removes a link named itself, never the folder it names", () => {
		const outside = filled(join(folder, "outside"), 2);
		symlinkSync(outside, join(folder, "link"));

		removeTree(join(folder, "link"));

		expect(existsSync(join(folder, "link"))).toBe(false);
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

	it("says why rm couldn't remove a tree", async () => {
		const tree = filled(join(folder, "tree", "sealed"), 1);
		// A folder its owner can't write keeps its files from rm too.
		const sealed = join(folder, "tree", "sealed");
		chmodSync(sealed, 0o555);
		try {
			expect(() => removeTree(join(folder, "tree"))).toThrow(
				/rm couldn't remove .*tree/,
			);
			await expect(removeTreeOff(join(folder, "tree"))).rejects.toThrow(
				/rm couldn't remove .*tree/,
			);
		} finally {
			chmodSync(sealed, 0o755);
		}
		expect(lstatSync(tree).isDirectory()).toBe(true);
	});

	it("finds a root's rm on this machine", () => {
		// Every other case here leans on one; without it they'd all throw.
		expect(() => removeTree(filled(join(folder, "t", "u"), 1))).not.toThrow();
		expect(removerFolders()).toContain("/bin");
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

			// Every round the swap landed mid-walk, so the race was run.
			expect(sync).toEqual({ lost: 0, swaps: ROUNDS });
			expect(off).toEqual({ lost: 0, swaps: ROUNDS });
		},
		RACE_TIMEOUT_MS,
	);
});

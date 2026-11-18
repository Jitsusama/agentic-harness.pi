/**
 * What a bash call keeps of itself on disk: private files, its status
 * and pid once written, its output kept to its tail, and nothing left
 * once removed or swept.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	carriedCalls,
	endOf,
	makeKept,
	markCarried,
	outputOf,
	pidOf,
	removeKept,
	rollIfFull,
	sweepKept,
	sweepKeptNowAndThen,
	teePersists,
} from "../../../../lib/internal/shell/kept.ts";

const PRIVATE = 0o600;
const PRIVATE_FOLDER = 0o700;
const PERMISSIONS = 0o777;

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A folder of its own, under which the kept folder is made. */
function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), "kept-"));
	made.push(dir);
	return join(dir, "kept");
}

/**
 * A folder holding only a `tee` that ends with `status`, as a PATH,
 * after `before` of the shell's own commands.
 */
function teeEnding(status: number, before = ""): string {
	const dir = mkdtempSync(join(tmpdir(), "tee-"));
	made.push(dir);
	const tee = join(dir, "tee");
	writeFileSync(tee, `#!/bin/sh\n${before}\nexit ${status}\n`);
	chmodSync(tee, PRIVATE_FOLDER);
	return dir;
}

describe("whether tee persists", () => {
	it("answers for the tee each PATH finds", async () => {
		const persists = teeEnding(0);
		const refuses = teeEnding(1);
		expect(await teePersists(persists), "a tee that writes on persists").toBe(
			true,
		);
		expect(await teePersists(refuses), "a tee that stops does not").toBe(false);
		expect(await teePersists(persists), "each answer kept apart").toBe(true);
	});

	// It is asked as a bash call starts, and in a host the loop it would
	// hold is every conversation's: 412 ms of one turn in a soak of twelve
	// (13 November).
	it("leaves the loop free while tee answers", async () => {
		const slow = teeEnding(0, "sleep 0.3");
		let turned = false;
		setImmediate(() => {
			turned = true;
		});
		const answer = await teePersists(slow);
		expect(turned, "the loop turned before tee answered").toBe(true);
		expect(answer, "whether tee writes on").toBe(true);
	});
});

describe("a kept call", () => {
	it("is made private, in a private folder, with nothing written yet", async () => {
		const where = folder();
		const path = await makeKept(where);
		expect(statSync(where).mode & PERMISSIONS).toBe(PRIVATE_FOLDER);
		for (const suffix of [".out", ".end", ".pid"]) {
			expect(
				statSync(`${path}${suffix}`).mode & PERMISSIONS,
				`${suffix} is the owner's alone`,
			).toBe(PRIVATE);
		}
		expect(endOf(path), "no status before the stub writes one").toBeUndefined();
		expect(pidOf(path), "no pid before the stub writes one").toBeUndefined();
	});

	// Made as each bash call starts, and in a host on the loop every
	// conversation shares: a busy disk held it in the files' openat 7
	// times in 287 hold samples (17 November).
	it("is made without holding the loop", async () => {
		const where = folder();
		const making = makeKept(where);
		expect(
			readdirSync(join(where, "..")).includes("kept") &&
				readdirSync(where).some((name) => name.endsWith(".pid")),
			"its last file waits for the loop to turn",
		).toBe(false);
		const path = await making;
		expect(existsSync(`${path}.pid`), "made once it settles").toBe(true);
	});

	it("reads the status and pid the stub wrote", async () => {
		const path = await makeKept(folder());
		writeFileSync(`${path}.end`, "7\n");
		writeFileSync(`${path}.pid`, "4242\n");
		expect(endOf(path)).toBe(7);
		expect(pidOf(path)).toBe(4242);
	});

	it("keeps only its output's tail once it outgrows the cap", async () => {
		const path = await makeKept(folder());
		writeFileSync(`${path}.out`, "aaaa\nbbbb\ncccc\n");
		rollIfFull(path, 10);
		expect(
			statSync(`${path}.out`).size,
			".out starts again, for tee to append to",
		).toBe(0);
		writeFileSync(`${path}.out`, "dddd\n", { flag: "a" });
		expect(outputOf(path)).toBe("bbbb\ncccc\ndddd\n");
	});

	it("leaves output under the cap where it is", async () => {
		const path = await makeKept(folder());
		writeFileSync(`${path}.out`, "short\n");
		rollIfFull(path, 100);
		expect(outputOf(path)).toBe("short\n");
	});

	it("names the group of each call handed on, and only those", async () => {
		const where = folder();
		const carried = await makeKept(where);
		const kept = await makeKept(where);
		writeFileSync(`${carried}.pid`, "4242\n");
		writeFileSync(`${kept}.pid`, "4343\n");
		markCarried(carried, "call-1");
		expect(
			statSync(`${carried}.carried`).mode & PERMISSIONS,
			"the mark is the owner's alone",
		).toBe(PRIVATE);
		const found = carriedCalls(where);
		expect([...found.groups]).toEqual([4242]);
		expect([...found.marks], "by the call's own mark too").toEqual(["call-1"]);
	});

	it("names no group before there is a folder", () => {
		const found = carriedCalls(folder());
		expect(found.groups.size + found.marks.size).toBe(0);
	});

	it("leaves nothing once removed, its mark included", async () => {
		const where = folder();
		const path = await makeKept(where);
		rollIfFull(path, 0);
		markCarried(path);
		await removeKept(path);
		expect(readdirSync(where)).toEqual([]);
	});

	// Removed as each bash call ends: its unlinks held a host's loop 14
	// times in 287 hold samples (17 November).
	it("is removed without holding the loop", async () => {
		const where = folder();
		const path = await makeKept(where);
		markCarried(path);
		writeFileSync(`${path}.job`, "{}");
		const removing = removeKept(path);
		expect(
			readdirSync(where).length,
			"its last files wait for the loop to turn",
		).toBeGreaterThan(0);
		await removing;
		expect(readdirSync(where)).toEqual([]);
	});

	// Removal now spans turns of the loop, so a pi ended partway through
	// leaves some of a call's files: never its marks to take it up again
	// without its status, or another pi would say an ended call twice.
	it("goes its marks first, so what is left never reads as a call to take up", async () => {
		const where = folder();
		const path = await makeKept(where);
		writeFileSync(`${path}.end`, "0\n");
		markCarried(path);
		writeFileSync(`${path}.job`, "{}");
		let removed = false;
		const left: string[][] = [];
		const look = () => {
			// Once removed, the test's folder goes with it.
			if (removed) return;
			left.push(readdirSync(where).map((name) => name.slice(-4)));
			setImmediate(look);
		};
		const removing = removeKept(path).then(() => {
			removed = true;
		});
		look();
		await removing;
		expect(
			left.some((names) => names.length > 0 && names.length < 5),
			"seen partway through",
		).toBe(true);
		const marked = left.filter(
			(names) => names.includes(".job") || names.includes("ried"),
		);
		expect(
			marked.filter((names) => !names.includes(".end")),
			"marked to take up, its status gone",
		).toEqual([]);
	});

	it("leaves its status where a mark won't go, so it still reads as ended", async () => {
		const where = folder();
		const path = await makeKept(where);
		writeFileSync(`${path}.end`, "0\n");
		mkdirSync(`${path}.carried`);
		writeFileSync(join(`${path}.carried`, "inside"), "");
		await expect(removeKept(path)).resolves.toBeUndefined();
		expect(endOf(path), "its status, for whatever finds the mark").toBe(0);
	});

	it("says nothing when removed twice", async () => {
		const path = await makeKept(folder());
		await removeKept(path);
		await expect(removeKept(path)).resolves.toBeUndefined();
	});

	// Its callers between processes leave it to run, so it must never reject.
	it("removes what it can and says nothing of a file it can't", async () => {
		const where = folder();
		const path = await makeKept(where);
		rollIfFull(path, 0);
		rmSync(`${path}.end`);
		mkdirSync(`${path}.end`);
		writeFileSync(join(`${path}.end`, "inside"), "");
		await expect(removeKept(path)).resolves.toBeUndefined();
		expect(readdirSync(where), "only what it couldn't").toEqual([
			`${path.split("/").at(-1)}.end`,
		]);
	});

	it("is swept a week on, and not before", async () => {
		const where = folder();
		const old = await makeKept(where);
		const fresh = await makeKept(where);
		const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		for (const suffix of [".out", ".end", ".pid"])
			utimesSync(`${old}${suffix}`, weekAgo, weekAgo);
		const sweeping = sweepKept(where);
		expect(readdirSync(where).length, "swept without holding the loop").toBe(6);
		await sweeping;
		expect(readdirSync(where).sort()).toEqual(
			[".end", ".out", ".pid"]
				.map((suffix) => `${fresh.split("/").at(-1)}${suffix}`)
				.sort(),
		);
	});

	// Every session start asked for a sweep, and a host starts dozens
	// after a boot: 752 files stated for each (18 November).
	it("is swept once an hour for the process, however many sessions start", async () => {
		const where = folder();
		const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		const age = async () => {
			const path = await makeKept(where);
			for (const suffix of [".out", ".end", ".pid"])
				utimesSync(`${path}${suffix}`, weekAgo, weekAgo);
		};
		const start = Date.now();
		await age();
		await sweepKeptNowAndThen(where, start);
		expect(readdirSync(where), "the first start sweeps").toEqual([]);
		await age();
		await sweepKeptNowAndThen(where, start + 1000);
		expect(readdirSync(where), "a start within the hour doesn't").toHaveLength(
			3,
		);
		await sweepKeptNowAndThen(where, start + 60 * 60 * 1000);
		expect(readdirSync(where), "one an hour on sweeps again").toEqual([]);
	});

	it("begins one sweep for starts that come while it runs", async () => {
		const where = folder();
		await makeKept(where);
		const start = Date.now();
		const settled: string[] = [];
		const first = sweepKeptNowAndThen(where, start).then(() =>
			settled.push("first"),
		);
		const second = sweepKeptNowAndThen(where, start + 1).then(() =>
			settled.push("second"),
		);
		await Promise.all([first, second]);
		expect(settled, "the second has nothing to wait for").toEqual([
			"second",
			"first",
		]);
	});

	it("is swept again once the clock steps back past its last sweep", async () => {
		const where = folder();
		const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		const start = Date.now();
		await sweepKeptNowAndThen(where, start);
		const path = await makeKept(where);
		for (const suffix of [".out", ".end", ".pid"])
			utimesSync(`${path}${suffix}`, weekAgo, weekAgo);
		await sweepKeptNowAndThen(where, start - 1000);
		expect(
			readdirSync(where),
			"not held off for however far it stepped",
		).toEqual([]);
	});
});

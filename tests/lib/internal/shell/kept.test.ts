/**
 * What a bash call keeps of itself on disk: private files, its status
 * and pid once written, its output kept to its tail, and nothing left
 * once removed or swept.
 */

import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	chmodSync,
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

/** A folder holding only a `tee` that ends with `status`, as a PATH. */
function teeEnding(status: number): string {
	const dir = mkdtempSync(join(tmpdir(), "tee-"));
	made.push(dir);
	const tee = join(dir, "tee");
	writeFileSync(tee, `#!/bin/sh\nexit ${status}\n`);
	chmodSync(tee, PRIVATE_FOLDER);
	return dir;
}

describe("whether tee persists", () => {
	it("answers for the tee each PATH finds", () => {
		const persists = teeEnding(0);
		const refuses = teeEnding(1);
		expect(teePersists(persists)).toBe(true);
		expect(teePersists(refuses)).toBe(false);
		expect(teePersists(persists), "each answer kept apart").toBe(true);
	});
});

describe("a kept call", () => {
	it("is made private, in a private folder, with nothing written yet", () => {
		const where = folder();
		const path = makeKept(where);
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

	it("reads the status and pid the stub wrote", () => {
		const path = makeKept(folder());
		writeFileSync(`${path}.end`, "7\n");
		writeFileSync(`${path}.pid`, "4242\n");
		expect(endOf(path)).toBe(7);
		expect(pidOf(path)).toBe(4242);
	});

	it("keeps only its output's tail once it outgrows the cap", () => {
		const path = makeKept(folder());
		writeFileSync(`${path}.out`, "aaaa\nbbbb\ncccc\n");
		rollIfFull(path, 10);
		expect(
			statSync(`${path}.out`).size,
			".out starts again, for tee to append to",
		).toBe(0);
		writeFileSync(`${path}.out`, "dddd\n", { flag: "a" });
		expect(outputOf(path)).toBe("bbbb\ncccc\ndddd\n");
	});

	it("leaves output under the cap where it is", () => {
		const path = makeKept(folder());
		writeFileSync(`${path}.out`, "short\n");
		rollIfFull(path, 100);
		expect(outputOf(path)).toBe("short\n");
	});

	it("names the group of each call handed on, and only those", () => {
		const where = folder();
		const carried = makeKept(where);
		const kept = makeKept(where);
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

	it("leaves nothing once removed, its mark included", () => {
		const where = folder();
		const path = makeKept(where);
		rollIfFull(path, 0);
		markCarried(path);
		removeKept(path);
		expect(readdirSync(where)).toEqual([]);
	});

	it("is swept a week on, and not before", () => {
		const where = folder();
		const old = makeKept(where);
		const fresh = makeKept(where);
		const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		for (const suffix of [".out", ".end", ".pid"])
			utimesSync(`${old}${suffix}`, weekAgo, weekAgo);
		sweepKept(where);
		expect(readdirSync(where).sort()).toEqual(
			[".end", ".out", ".pid"]
				.map((suffix) => `${fresh.split("/").at(-1)}${suffix}`)
				.sort(),
		);
	});
});

/**
 * What the fence does before it starts about a link or file a fenced
 * command left where pi and node keep compiled code in `/tmp`.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAsidePlanted } from "../../../../lib/internal/fence/fence-temp-caches.ts";

describe("setting aside what was planted where a cache belongs", () => {
	let temp: string;

	beforeEach(() => {
		temp = mkdtempSync(join(tmpdir(), "temp-caches-"));
	});

	afterEach(() => {
		rmSync(temp, { recursive: true, force: true });
	});

	it("moves a link and a file aside, named for when they were found", () => {
		const link = join(temp, "jiti");
		const file = join(temp, "node-compile-cache");
		symlinkSync(join(temp, "elsewhere"), link);
		writeFileSync(file, "");
		setAsidePlanted([link, file], () => 42);
		expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
		expect(existsSync(file)).toBe(false);
		expect(readdirSync(temp).sort()).toEqual([
			"jiti.set-aside-42",
			"node-compile-cache.set-aside-42",
		]);
	});

	it("leaves a cache that is a folder, and one not there, as they are", () => {
		const folder = join(temp, "jiti");
		mkdirSync(folder);
		writeFileSync(join(folder, "entry.mjs"), "compiled");
		setAsidePlanted([folder, join(temp, "node-compile-cache")]);
		expect(readdirSync(temp)).toEqual(["jiti"]);
		expect(readdirSync(folder)).toEqual(["entry.mjs"]);
	});
});

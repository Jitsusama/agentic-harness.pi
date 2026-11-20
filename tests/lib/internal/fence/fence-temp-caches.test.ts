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
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	setAsidePlanted,
	TEMP_CODE_CACHES,
	tempCodeCaches,
} from "../../../../lib/internal/fence/fence-temp-caches.ts";

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
		const aside = readdirSync(temp).sort();
		expect(aside).toHaveLength(2);
		expect(aside[0]).toMatch(/^jiti\.set-aside-42-[0-9a-f]{8}$/);
		expect(aside[1]).toMatch(/^node-compile-cache\.set-aside-42-[0-9a-f]{8}$/);
	});

	it("moves aside even where a fenced command made the name it would take", () => {
		const link = join(temp, "jiti");
		symlinkSync(join(temp, "elsewhere"), link);
		mkdirSync(join(temp, "jiti.set-aside-42"));
		setAsidePlanted([link], () => 42);
		expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
	});

	it("names the Mac's own temporary folder's caches beside /tmp's, and only there", () => {
		expect(tempCodeCaches("linux", () => [temp])).toEqual(TEMP_CODE_CACHES);
		expect(tempCodeCaches("darwin", () => [temp])).toEqual([
			...TEMP_CODE_CACHES,
			join(realpathSync(temp), "node-compile-cache"),
			join(realpathSync(temp), "jiti"),
		]);
		expect(tempCodeCaches("darwin", () => ["/tmp"])).toEqual(TEMP_CODE_CACHES);
	});

	it("holds the Mac account's own caches whatever TMPDIR the fence was handed", () => {
		const account = join(temp, "T");
		const handed = join(temp, "quest");
		mkdirSync(account);
		mkdirSync(handed);
		const own = realpathSync(account);
		const ownCaches = [join(own, "node-compile-cache"), join(own, "jiti")];
		// Handed a quest's folder, or none, or one that is gone: the
		// account's are held all the same.
		expect(tempCodeCaches("darwin", () => [account, handed])).toEqual([
			...TEMP_CODE_CACHES,
			...ownCaches,
			join(realpathSync(handed), "node-compile-cache"),
			join(realpathSync(handed), "jiti"),
		]);
		expect(tempCodeCaches("darwin", () => [account, "/tmp"])).toEqual([
			...TEMP_CODE_CACHES,
			...ownCaches,
		]);
		expect(
			tempCodeCaches("darwin", () => [account, join(temp, "gone")]),
		).toEqual([...TEMP_CODE_CACHES, ...ownCaches]);
		expect(tempCodeCaches("darwin", () => [account, account])).toEqual([
			...TEMP_CODE_CACHES,
			...ownCaches,
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

/**
 * A tree set aside parts its `.git` under a free name, and a tree whose
 * names were all taken first is refused rather than searched for good.
 * Its own file, since the random names are pinned here for every test
 * in it, so a planted name is the one the search meets each time.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAsideWhole } from "../../../lib/core/work/stranded.ts";

vi.mock("node:crypto", async (original) => ({
	...(await original<typeof import("node:crypto")>()),
	// Every random name the same, as a command that filled them all
	// would leave the search finding each one taken.
	randomBytes: (size: number) => Buffer.alloc(size),
}));

let root = "";
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "stranded-names-")));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("setAsideWhole's spare names", () => {
	it("refuses a tree whose spare names are taken, and puts it back", () => {
		const path = join(root, "trees", "snapshot-full");
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, ".git"), "gitdir: /nowhere\n");
		writeFileSync(join(path, ".git-was"), "planted\n");
		writeFileSync(join(path, ".git-was-00000000"), "planted\n");
		const into = join(root, "stranded");

		expect(() => setAsideWhole(path, into)).toThrow(/no free name was left/);
		expect(existsSync(join(path, ".git")), "it is back as it was").toBe(true);
		expect(readdirSync(into), "nothing is left aside").toEqual([]);
	});

	it("parts a .git under the first free name", () => {
		const path = join(root, "trees", "snapshot-free");
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, ".git"), "gitdir: /nowhere\n");
		writeFileSync(join(path, ".git-was"), "mine\n");

		const aside = setAsideWhole(path, join(root, "stranded"));

		expect(readdirSync(aside).sort()).toEqual([
			".git-was",
			".git-was-00000000",
		]);
	});
});

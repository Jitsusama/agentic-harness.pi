/**
 * The fence's folders for this account alone: made private, a race to
 * make one lost quietly, and a folder judged private only where it is
 * this account's own, unreachable by others, and not a link.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isPrivateFolder,
	makeFolder,
} from "../../../../lib/internal/fence/fence-folders.ts";

let base = "";

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "fence-folders-"));
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("a folder made for this account alone", () => {
	it("is made private to this account", () => {
		makeFolder(join(base, "one"));
		expect(statSync(join(base, "one")).mode & 0o777).toBe(0o700);
	});

	it("leaves one another pi made first as it found it, for the caller to judge", () => {
		mkdirSync(join(base, "one"), { mode: 0o755 });
		expect(() => makeFolder(join(base, "one"))).not.toThrow();
		expect(statSync(join(base, "one")).mode & 0o777).toBe(0o755);
	});

	it("throws on any other failure, such as a missing parent", () => {
		expect(() => makeFolder(join(base, "none", "one"))).toThrow(
			expect.objectContaining({ code: "ENOENT" }),
		);
	});
});

describe("whether a folder is this account's own and private", () => {
	it("takes a folder of mode 700", () => {
		makeFolder(join(base, "one"));
		expect(isPrivateFolder(join(base, "one")), "a folder of mode 700").toBe(
			true,
		);
	});

	it("refuses one others can reach, a link to a private one, a file and nothing", () => {
		mkdirSync(join(base, "reachable"));
		chmodSync(join(base, "reachable"), 0o750);
		makeFolder(join(base, "private"));
		symlinkSync(join(base, "private"), join(base, "linked"));
		writeFileSync(join(base, "file"), "");
		chmodSync(join(base, "file"), 0o700);
		for (const name of ["reachable", "linked", "file", "missing"]) {
			expect(isPrivateFolder(join(base, name)), name).toBe(false);
		}
	});
});

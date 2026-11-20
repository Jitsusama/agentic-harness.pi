/**
 * The stamp a sweep outside every pi host leaves beside the sweep's lock,
 * and which hosts' own sweeps it stands down, and for how long.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	markSweptOutside,
	sweptOutsideSince,
} from "../../../../lib/core/work/sweep-rest.ts";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A lock's path in a work state folder nothing has made yet. */
function lockInNewFolder(): string {
	const root = mkdtempSync(join(tmpdir(), "sweep-rest-"));
	made.push(root);
	return join(root, "state", "work", "sweep.lock");
}

const NOW = Date.UTC(2026, 10, 19, 22, 0, 0);
// Spelt out rather than read from the module, so a hold changed there
// fails here.
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const GIT = ["git-worktree"];
const GIT_AND_WORLD = ["git-worktree", "world-dev-tree"];

it("stamps a sweep outside the hosts on a machine that has never swept", () => {
	const lock = lockInNewFolder();

	markSweptOutside(lock, NOW, GIT);

	expect(
		sweptOutsideSince(lock, NOW + 1000, GIT),
		"why a host's sweep stands down a second later",
	).toBe("a sweep outside the hosts ran 1 s ago");
});

it("stands the hosts down only until the stamp is two hours old", () => {
	const lock = lockInNewFolder();
	markSweptOutside(lock, NOW, GIT);

	expect(
		sweptOutsideSince(lock, NOW + TWO_HOURS_MS - 1000, GIT),
		"a second before the hold runs out",
	).toBeDefined();
	expect(
		sweptOutsideSince(lock, NOW + TWO_HOURS_MS, GIT),
		"once the hold has run out",
	).toBeUndefined();
});

it("stands nobody down for a stamp from the future, as a clock set back leaves", () => {
	const lock = lockInNewFolder();
	markSweptOutside(lock, NOW, GIT);

	expect(
		sweptOutsideSince(lock, NOW - 1000, GIT),
		"a second before the stamp",
	).toBe(undefined);
});

it("stands nobody down where no sweep outside has run", () => {
	expect(sweptOutsideSince(lockInNewFolder(), NOW, GIT), "with no stamp").toBe(
		undefined,
	);
});

it("stands down only a host whose providers the sweep outside all judged", () => {
	const lock = lockInNewFolder();
	markSweptOutside(lock, NOW, GIT);

	expect(
		sweptOutsideSince(lock, NOW + 1000, GIT_AND_WORLD),
		"a host with World's provider, after a sweep that judged only git's",
	).toBeUndefined();

	markSweptOutside(lock, NOW, GIT_AND_WORLD);

	expect(
		sweptOutsideSince(lock, NOW + 1000, GIT_AND_WORLD),
		"the same host, once a sweep judged World's trees too",
	).toBeDefined();
	expect(
		sweptOutsideSince(lock, NOW + 1000, GIT),
		"a host with only git's provider",
	).toBeDefined();
});

it("stands nobody down for a stamp that names no providers it can read", () => {
	const lock = lockInNewFolder();
	markSweptOutside(lock, NOW, GIT);
	writeFileSync(`${lock}.outside`, "");

	expect(
		sweptOutsideSince(lock, NOW, GIT),
		"a stamp with no list in it, as a sweep on older code wrote",
	).toBeUndefined();
});

it("replaces a link planted where the stamp goes rather than writing through it", () => {
	const lock = lockInNewFolder();
	mkdirSync(dirname(lock), { recursive: true });
	const elsewhere = join(dirname(lock), "someone-elses");
	writeFileSync(elsewhere, "theirs");
	symlinkSync(elsewhere, `${lock}.outside`);

	markSweptOutside(lock, NOW, GIT);

	expect(readFileSync(elsewhere, "utf8"), "the file the link named").toBe(
		"theirs",
	);
	expect(
		sweptOutsideSince(lock, NOW + 1000, GIT),
		"the stamp written in the link's place",
	).toBeDefined();
});

/**
 * The stamp a sweep outside every pi host leaves beside the sweep's lock,
 * and which hosts' own sweeps it stands down, and for how long.
 */

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
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

/** Writes `text` as the stamp, dated as a sweep at NOW would date it. */
function stampAtNow(lock: string, text: string): void {
	writeFileSync(`${lock}.outside`, text);
	utimesSync(`${lock}.outside`, NOW / 1000, NOW / 1000);
}

it("stands nobody down for a stamp that names no providers it can read", () => {
	const lock = lockInNewFolder();
	markSweptOutside(lock, NOW, GIT);
	stampAtNow(lock, JSON.stringify({ judged: GIT }));

	expect(
		sweptOutsideSince(lock, NOW + 1000, GIT),
		"a well-formed stamp, dated the same way",
	).toBe("a sweep outside the hosts ran 1 s ago");

	stampAtNow(lock, "");

	expect(
		sweptOutsideSince(lock, NOW, GIT),
		"an empty stamp, as a sweep on older code wrote",
	).toBeUndefined();

	stampAtNow(lock, JSON.stringify({ judged: "git-worktree" }));

	expect(
		sweptOutsideSince(lock, NOW, GIT),
		"a stamp whose providers are no list",
	).toBeUndefined();
});

it("stands nobody down for a link where the stamp goes, even to a good stamp", () => {
	const lock = lockInNewFolder();
	markSweptOutside(lock, NOW, GIT);
	const good = `${lock}.good`;
	writeFileSync(good, JSON.stringify({ judged: GIT }));
	utimesSync(good, NOW / 1000, NOW / 1000);
	rmSync(`${lock}.outside`);
	symlinkSync(good, `${lock}.outside`);

	expect(
		sweptOutsideSince(lock, NOW + 1000, GIT),
		"a link, which a host's read would follow anywhere",
	).toBeUndefined();
});

it("stands nobody down for a stamp past four kilobytes", () => {
	const lock = lockInNewFolder();
	markSweptOutside(lock, NOW, GIT);
	stampAtNow(
		lock,
		JSON.stringify({ judged: GIT, padding: "x".repeat(4 * 1024) }),
	);

	expect(
		sweptOutsideSince(lock, NOW + 1000, GIT),
		"a stamp larger than a sweep writes",
	).toBeUndefined();
});

it("stands nobody down, and waits on nothing, for a pipe where the stamp goes", () => {
	const lock = lockInNewFolder();
	mkdirSync(dirname(lock), { recursive: true });
	execFileSync("mkfifo", [`${lock}.outside`]);

	expect(
		sweptOutsideSince(lock, NOW, GIT),
		"a pipe nobody writes, which a blocking read would wait on for good",
	).toBeUndefined();
});

it("says why when it can't write the stamp", () => {
	const lock = lockInNewFolder();
	// A folder where the stamp goes, which no file can be renamed over.
	mkdirSync(`${lock}.outside`, { recursive: true });

	expect(
		markSweptOutside(lock, NOW, GIT),
		"what it said of the stamp it couldn't write",
	).toBeDefined();
	expect(readdirSync(dirname(lock)), "what it left beside the lock").toEqual([
		"sweep.lock.outside",
	]);
});

it("replaces a link planted where the stamp goes rather than writing through it", () => {
	const lock = lockInNewFolder();
	mkdirSync(dirname(lock), { recursive: true });
	const elsewhere = join(dirname(lock), "someone-elses");
	writeFileSync(elsewhere, "theirs");
	symlinkSync(elsewhere, `${lock}.outside`);

	expect(markSweptOutside(lock, NOW, GIT), "why it couldn't stamp").toBe(
		undefined,
	);

	expect(readFileSync(elsewhere, "utf8"), "the file the link named").toBe(
		"theirs",
	);
	expect(
		sweptOutsideSince(lock, NOW + 1000, GIT),
		"the stamp written in the link's place",
	).toBeDefined();
});

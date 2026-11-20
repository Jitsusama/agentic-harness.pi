/**
 * The stamp a sweep outside every pi host leaves beside the sweep's lock,
 * and how long it stands the hosts' own sweeps down.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("stamps a sweep outside the hosts on a machine that has never swept", () => {
	const lock = lockInNewFolder();

	markSweptOutside(lock, NOW);

	expect(
		sweptOutsideSince(lock, NOW + 1000),
		"why a host's sweep stands down a second later",
	).toBe("a sweep outside the hosts ran 1 s ago");
});

it("stands the hosts down only until the stamp is two hours old", () => {
	const lock = lockInNewFolder();
	markSweptOutside(lock, NOW);

	expect(
		sweptOutsideSince(lock, NOW + TWO_HOURS_MS - 1000),
		"a second before the hold runs out",
	).toBeDefined();
	expect(
		sweptOutsideSince(lock, NOW + TWO_HOURS_MS),
		"once the hold has run out",
	).toBeUndefined();
});

it("stands nobody down for a stamp from the future, as a clock set back leaves", () => {
	const lock = lockInNewFolder();
	markSweptOutside(lock, NOW);

	expect(sweptOutsideSince(lock, NOW - 1000), "a second before the stamp").toBe(
		undefined,
	);
});

it("stands nobody down where no sweep outside has run", () => {
	expect(sweptOutsideSince(lockInNewFolder(), NOW), "with no stamp").toBe(
		undefined,
	);
});

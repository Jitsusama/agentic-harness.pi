/** Whether a carry waits on its session's reload onto its install's code. */

import {
	lutimesSync,
	mkdirSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BEHIND_FOR_MS,
	behindItsInstall,
} from "../../../../lib/internal/carry/current-code.ts";
import { folder, removeAll } from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

const NOW = Date.parse("2026-11-27T10:00:00Z");
const OLD = "03c16f4cfe6b0b8ed5afba531da67409c1d6729c";
const NEXT = "1812efc7c112daf363e4b8a5619d0d2208a3ea29";
const LATEST = "9255f6d13012e75c85e1b7e9dab118755c1d7f94";

/**
 * An install as core.nix's pi-packages leaves it, each of its times as
 * how long before `NOW`.
 */
interface Installed {
	/** Each version's folder within the install, and when it was made. */
	readonly versions: Record<string, number>;
	/** The version folder the install's `current` link names. */
	readonly current: string;
	/** When the link was last moved, `NOW` where unsaid. */
	readonly moved?: number;
	/** When the install left each version it marked in `retired/`. */
	readonly retired?: Record<string, number>;
}

/** Sets `path`'s times, or a link's own with `set`, to `ago` before `NOW`. */
function dated(path: string, ago: number, set = utimesSync): void {
	const at = (NOW - ago) / 1000;
	set(path, at, at);
}

/** Makes the install `installed` describes; answers its folder. */
function install(installed: Installed): string {
	const root = folder(made, "install");
	for (const [version, ago] of Object.entries(installed.versions)) {
		const at = join(root, version);
		mkdirSync(at, { recursive: true });
		dated(at, ago);
	}
	mkdirSync(join(root, "retired"));
	for (const [commit, ago] of Object.entries(installed.retired ?? {})) {
		const marker = join(root, "retired", commit);
		writeFileSync(marker, "");
		dated(marker, ago);
	}
	const link = join(root, "current");
	symlinkSync(installed.current, link);
	dated(link, installed.moved ?? 0, lutimesSync);
	return root;
}

const minutes = (count: number) => count * 60_000;

/** The refusal for a session on `running`, left `ago` minutes since. */
const refusal = (running: string, ago: number, current: string) =>
	`it runs harness ${running.slice(0, 12)}, which its install left ${ago} minutes ago for ${current.slice(0, 12)}, so it may lack a carry fix; ask the carry again once it reloads, which /reload does now and a session following its install does once idle`;

describe("a carry from code its install has left", () => {
	it("waits on its reload once the install left it past the bar, naming both versions", () => {
		const root = install({
			versions: {
				[`versions/${OLD}`]: minutes(3000),
				[`versions/${LATEST}`]: minutes(3000) - 1,
			},
			current: `versions/${LATEST}`,
			retired: { [OLD]: BEHIND_FOR_MS + minutes(1) },
		});

		const why = behindItsInstall(join(root, "versions", OLD), NOW);

		expect(why).toBe(refusal(OLD, 16, LATEST));
	});

	// Review of #2355, F4 and its kin: a version is made long before it is
	// made current, and a copy can keep its times, so only the install's
	// own record of the move says when it left the one a session runs.
	it("dates the leaving by the install's record of it, though a version was made within the bar", () => {
		const root = install({
			versions: {
				[`versions/${OLD}`]: minutes(3000),
				[`versions/${NEXT}`]: minutes(2),
				[`versions/${LATEST}`]: minutes(1),
			},
			current: `versions/${LATEST}`,
			moved: minutes(1),
			retired: { [OLD]: BEHIND_FOR_MS + minutes(5) },
		});

		const why = behindItsInstall(join(root, "versions", OLD), NOW);

		expect(why).toBe(refusal(OLD, 20, LATEST));
	});

	it("goes on while the install left it within the bar, since its reload is due", () => {
		const root = install({
			versions: {
				[`versions/${OLD}`]: minutes(3000),
				[`versions/${LATEST}`]: minutes(3000) - 1,
			},
			current: `versions/${LATEST}`,
			retired: { [OLD]: BEHIND_FOR_MS - minutes(1) },
		});

		expect(behindItsInstall(join(root, "versions", OLD), NOW)).toBeUndefined();
	});

	it("goes on past a version built after it but never made current, by when the link last moved", () => {
		const root = install({
			versions: {
				[`versions/${OLD}`]: minutes(3000),
				[`versions/${NEXT}`]: BEHIND_FOR_MS + minutes(30),
				[`versions/${LATEST}`]: minutes(3),
			},
			current: `versions/${LATEST}`,
			moved: minutes(2),
		});

		expect(behindItsInstall(join(root, "versions", OLD), NOW)).toBeUndefined();
	});

	// F26: a session started before the install moved its versions out of
	// releases/ runs from there until it reloads.
	it("waits on the reload of a session in releases/ once its install's link moved past the bar", () => {
		const root = install({
			versions: {
				[`releases/${OLD}`]: minutes(3000),
				[`versions/${LATEST}`]: minutes(2000),
			},
			current: `versions/${LATEST}`,
			moved: BEHIND_FOR_MS + minutes(10),
		});

		const why = behindItsInstall(join(root, "releases", OLD), NOW);

		expect(why).toBe(refusal(OLD, 25, LATEST));
	});

	it.each([
		["goes on at the bar itself", BEHIND_FOR_MS, undefined],
		[
			"waits a millisecond past it",
			BEHIND_FOR_MS + 1,
			refusal(OLD, 15, LATEST),
		],
	])("%s", (_case, ago, expected) => {
		const root = install({
			versions: {
				[`versions/${OLD}`]: minutes(3000),
				[`versions/${LATEST}`]: minutes(1),
			},
			current: `versions/${LATEST}`,
			retired: { [OLD]: ago },
		});

		expect(behindItsInstall(join(root, "versions", OLD), NOW)).toBe(expected);
	});

	// F12: a doubt about the install never refuses a carry.
	it.each([
		["a current link onto nothing", `versions/${NEXT}`, OLD],
		["a version it runs that is gone", `versions/${LATEST}`, NEXT],
	])("goes on from %s", (_case, current, running) => {
		const root = install({
			versions: {
				[`versions/${OLD}`]: minutes(3000),
				[`versions/${LATEST}`]: minutes(3000) - 1,
			},
			current,
			moved: BEHIND_FOR_MS + minutes(60),
			retired: { [OLD]: BEHIND_FOR_MS + minutes(60) },
		});

		expect(
			behindItsInstall(join(root, "versions", running), NOW),
		).toBeUndefined();
	});

	it("goes on from the install's own version, however old", () => {
		const root = install({
			versions: { [`versions/${OLD}`]: minutes(3000) },
			current: `versions/${OLD}`,
			moved: minutes(3000),
		});

		expect(behindItsInstall(join(root, "versions", OLD), NOW)).toBeUndefined();
	});

	it("goes on from code outside an install of whole versions", () => {
		const tree = folder(made, "tree");

		expect(behindItsInstall(tree, NOW)).toBeUndefined();
	});
});

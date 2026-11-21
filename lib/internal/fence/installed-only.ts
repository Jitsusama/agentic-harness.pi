/**
 * Whether what a fenced session's children load lies where no fenced
 * command can write it: pi's installed packages, which the fence holds
 * read-only (`fence-home.ts`).
 *
 * A child's pi starts outside the fence its commands run in, and loads
 * this package's own files there as the person: its budget, brief and
 * journal packs, its supervisor, the fence's own bash. A tree the work
 * broker cut is one the session's fenced commands may write, so a child
 * started from a session running on a tree would run what a fenced
 * command planted there, outside the fence (ISXEG8, 21 November). The
 * same holds for an unisolated child, which loads this package from
 * wherever the person's settings name it. So children run fenced only
 * from the install; a session on a tree reloads onto it first.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	installRoot,
	packageName,
	piPackageSettings,
} from "../reload/settings.ts";

/** Where pi's packages are installed, really, or nothing when there are none. */
export function installedPackages(home: string = homedir()): string | null {
	try {
		return realpathSync(join(home, ".local", "share", "pi-packages"));
	} catch {
		return null;
	}
}

/** Whether `real`, a path already followed, lies inside `root`. */
export function inside(real: string, root: string | null): boolean {
	return root !== null && (real === root || real.startsWith(root + sep));
}

/** This package's own folder, followed, as this process loaded it. */
export function packageRoot(): string {
	const own = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	try {
		return realpathSync(own);
	} catch {
		return own;
	}
}

/**
 * Where the person's settings load this package from, followed, which
 * is what an unisolated child loads: nothing when they name none or
 * can't be read.
 */
export function settingsHarness(): string | undefined {
	try {
		const name = packageName(packageRoot()) ?? "agentic-harness.pi";
		const root = installRoot(piPackageSettings(), name);
		return root === undefined ? undefined : realpathSync(root);
	} catch {
		return undefined;
	}
}

/** Said in each refusal: the way back to children that run. */
const RELOAD = 'Reload onto the install (reload with onto "installed") first';

/**
 * Why children this session would start fenced can't start, or nothing:
 * this package runs from outside the install, or, for an unisolated
 * child, the person's settings load it from outside or not at all.
 */
export function fencedChildrenRefusal(
	unisolated: boolean,
	root: string | null = installedPackages(),
	own: string = packageRoot(),
	harness: () => string | undefined = settingsHarness,
): string | undefined {
	if (!inside(own, root)) {
		return `This session runs the harness from ${own}, outside pi's installed packages, where its fenced commands may write; each child would load this package's own files from there outside the fence. ${RELOAD}.`;
	}
	if (!unisolated) return undefined;
	const loaded = harness();
	if (loaded === undefined) {
		return `An unisolated child loads the harness from the person's settings, which name none, so its bash would be pi's plain one, run outside the fence. Start the subagents isolated.`;
	}
	if (!inside(loaded, root)) {
		return `An unisolated child loads the harness from the person's settings, which name ${loaded}, outside pi's installed packages, where fenced commands may write. Point the settings at the install, or start the subagents isolated.`;
	}
	return undefined;
}

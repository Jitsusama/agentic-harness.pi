/**
 * Whether what a fenced session's children load lies where no fenced
 * command can write it: pi's installed packages, which the fence holds
 * read-only (`fence-home.ts`).
 *
 * A child's pi starts outside the fence its commands run in, and loads
 * this package's own files there as the person: its budget, brief and
 * journal packs, its supervisor, the fence's own bash, and every
 * extension a loaded package registered as a default. A tree the work
 * broker cut is one the session's fenced commands may write, so a child
 * started from a session running on a tree would run what a fenced
 * command planted there, outside the fence (ISXEG8, 21 November). An
 * unisolated child also loads every extension the person's settings
 * name. So children of a fenced session run only from the install; a
 * session on a tree reloads onto it first.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	installRoot,
	packageName,
	piPackageSettings,
	settingsExtensions,
} from "../reload/settings.ts";

/** Where pi's packages are installed, under the home folder. */
const PACKAGES = join(".local", "share", "pi-packages");

/**
 * Where pi's packages are installed, really, or nothing when there are
 * none. The fence holds the folder read-only by its name, which a link
 * there would carry to somewhere it doesn't hold, so a linked one counts
 * as none.
 */
export function installedPackages(home: string = homedir()): string | null {
	try {
		const real = realpathSync(join(home, PACKAGES));
		return real === join(realpathSync(home), PACKAGES) ? real : null;
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

/** Said where the install is meant: the one folder the fence holds read-only. */
const INSTALL = `pi's installed packages (~/${PACKAGES})`;

/** `path` followed, or nothing when it isn't there. */
function followed(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** Each of `paths` that doesn't lie, followed, inside `root`. */
function outsideOf(paths: readonly string[], root: string | null): string[] {
	return paths.filter((path) => {
		const real = followed(path);
		return real === undefined || !inside(real, root);
	});
}

/** What the gate reads, each its own so a test can say where it lies. */
export interface Places {
	readonly root: string | null;
	readonly own: string;
	readonly harness: () => string | undefined;
}

/** Where things lie on this machine, read as the gate asks. */
export function placesHere(): Places {
	return {
		root: installedPackages(),
		own: packageRoot(),
		harness: settingsHarness,
	};
}

/**
 * Why children of a fenced session can't start, or nothing: this
 * package runs from outside the install, an extension registered as
 * every child's default lies outside it, or, for an unisolated child,
 * the person's settings load this package from outside or not at all.
 */
export function fencedChildrenRefusal(
	unisolated: boolean,
	defaults: readonly string[],
	places: Places = placesHere(),
): string | undefined {
	const { root, own, harness } = places;
	if (!inside(own, root)) {
		return `This session runs the harness from ${own}, outside ${INSTALL}, where its fenced commands may write; each child would load this package's own files from there outside the fence. ${RELOAD}.`;
	}
	const strays = outsideOf(defaults, root);
	if (strays.length > 0) {
		return `An extension registered for every subagent lies outside ${INSTALL}, where fenced commands may write, and each child would load it outside the fence: ${strays.join(", ")}. Install the package that registers it, or start this session without it.`;
	}
	if (!unisolated) return undefined;
	const loaded = harness();
	if (loaded === undefined) {
		return `An unisolated child loads the harness from the person's settings, which name none, so its bash would be pi's plain one, run outside the fence. Start the subagents isolated.`;
	}
	if (!inside(loaded, root)) {
		return `An unisolated child loads the harness from the person's settings, which name ${loaded}, outside ${INSTALL}, where fenced commands may write. Point the settings at the install, or start the subagents isolated.`;
	}
	return undefined;
}

/**
 * Why an unisolated child of a fenced session can't start, or nothing:
 * an extension the person's settings load, from a package or their own
 * list, lies outside the install. The settings themselves sit in pi's
 * agent folder, which the fence holds read-only, so what is read here is
 * what the child reads.
 */
export async function settingsRefusal(
	root: string | null = installedPackages(),
	loaded: () => Promise<string[]> = settingsExtensions,
): Promise<string | undefined> {
	let paths: string[];
	try {
		paths = await loaded();
	} catch (error) {
		return `An unisolated child loads every extension the person's settings name, and they couldn't be read (${error instanceof Error ? error.message : String(error)}). Start the subagents isolated.`;
	}
	const strays = outsideOf(paths, root);
	return strays.length === 0
		? undefined
		: `An unisolated child loads every extension the person's settings name, and these lie outside ${INSTALL}, where fenced commands may write: ${strays.join(", ")}. Start the subagents isolated.`;
}

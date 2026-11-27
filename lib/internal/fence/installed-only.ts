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
 * session on a tree reloads onto it first. A session whose own harness
 * was loaded from the Nix store, as a room's is, may start them too,
 * its children taking the fence's packs from that same copy (ISXEG8's
 * #2328), but only while this account can't change that copy or any
 * folder above it. What a package registers or the settings name may
 * also lie in pi's agent folder, which the fence holds read-only too,
 * or anywhere in the Nix store, which the fence doesn't hold itself.
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	installRoot,
	packageName,
	piPackageSettings,
	settingsExtensions,
} from "../reload/settings.ts";

/** Where pi's packages are installed, under the home folder. */
const PACKAGES = join(".local", "share", "pi-packages");

/** pi's agent folder, under the home folder: its settings and what it finds. */
const AGENT = join(".pi", "agent");

/**
 * The Nix store: where a room's image lays out the harness and the
 * packages it loads. Any user may add a path to it through the daemon,
 * and whether this account can change one is canChange's to say.
 */
export const NIX_STORE = "/nix/store";

/**
 * The folder `name` names under the home folder, really, or nothing
 * when it isn't there. The fence holds it read-only by its name, which
 * a link there would carry to somewhere it doesn't hold, so a linked one
 * counts as none.
 */
function heldByName(home: string, name: string): string | null {
	try {
		const real = realpathSync(join(home, name));
		return real === join(realpathSync(home), name) ? real : null;
	} catch {
		return null;
	}
}

/** Where pi's packages are installed, really, or nothing when there are none. */
export function installedPackages(home: string = homedir()): string | null {
	return heldByName(home, PACKAGES);
}

/**
 * The other places no fenced command can write that a child may load
 * from: pi's agent folder, where pi finds extensions of its own accord
 * and installs its own packages, and the Nix store.
 */
export function heldElsewhere(home: string = homedir()): string[] {
	const agent = heldByName(home, AGENT);
	return agent === null ? [NIX_STORE] : [agent, NIX_STORE];
}

/** Whether `real`, a path already followed, lies inside `root`. */
export function inside(real: string, root: string | null): boolean {
	return root !== null && (real === root || real.startsWith(root + sep));
}

/**
 * Whether this account could change `path`: write it, or, owning it,
 * make it writable again. A read-only mount answers no even for root,
 * since the fence leaves its commands no capabilities to remount it
 * with; a store laid out by a single-user Nix, or written by root on a
 * writable mount, answers yes, since the fence doesn't bind the store
 * read-only itself. On a Mac every store path answers yes: the fence
 * hands its commands Nix's own daemon, which takes the person as a
 * trusted client that may delete a live path and add another in its
 * place. A path it can't read answers yes too, since nothing shows it
 * can't be changed.
 */
export function canChange(path: string): boolean {
	if (process.platform === "darwin" && inside(path, NIX_STORE)) return true;
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch (error) {
		if (readOnlyMount(error)) return false;
	}
	try {
		return statSync(path).uid === process.getuid?.();
	} catch {
		// Nothing there, or nothing readable: it isn't shown unchangeable.
		return true;
	}
}

/** Whether a write was refused because the whole mount is read-only. */
function readOnlyMount(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EROFS"
	);
}

/**
 * Whether this account can change neither `path` nor any folder above
 * it, through which it could move `path` aside and put its own in its
 * place.
 */
export function unchangeable(
	path: string,
	changeable: (path: string) => boolean = canChange,
): boolean {
	for (let at = path; ; at = dirname(at)) {
		if (changeable(at)) return false;
		if (dirname(at) === at) return true;
	}
}

/**
 * The store path `own` lies in, when it lies in `store` and this
 * account can change neither `own` nor any folder above it, or nothing.
 */
export function heldStoreCopy(
	own: string,
	store: string = NIX_STORE,
	changeable: (path: string) => boolean = canChange,
): string | undefined {
	if (!inside(own, store) || own === store) return undefined;
	const [entry] = own.slice(store.length + 1).split(sep);
	if (entry === undefined || entry === "") return undefined;
	const copy = join(store, entry);
	return unchangeable(own, changeable) ? copy : undefined;
}

/**
 * Why a child may not load `pack` from the held store copy `copy`, or
 * nothing: it must be there, lie in that copy once followed, and be
 * one this account can't change, nor any folder on the way to it.
 */
export function heldPackRefusal(
	pack: string,
	copy: string,
	changeable: (path: string) => boolean = canChange,
): string | undefined {
	let real: string;
	try {
		real = realpathSync(pack);
	} catch {
		return `${pack} can't be found`;
	}
	if (!inside(real, copy)) {
		return `${pack} lies outside this harness's copy in the Nix store, ${copy}`;
	}
	return unchangeable(real, changeable)
		? undefined
		: `${real} is one this account could change`;
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

/**
 * Whether `path` is named inside one of `roots` and each step of its
 * name, followed, lies inside one of them too. A child loads each path
 * as it is named, not as it was followed here, so every link on the way
 * must sit in a folder no fenced command could change after this check.
 */
function heldAllTheWay(
	path: string,
	roots: readonly (string | null)[],
): boolean {
	const held = (real: string | undefined) =>
		real !== undefined && roots.some((root) => inside(real, root));
	const named = resolve(path);
	const root = roots.find((each) => inside(named, each));
	if (root === undefined || root === null) return false;
	let step = root;
	for (const part of named.slice(root.length).split(sep).filter(Boolean)) {
		step = join(step, part);
		if (!held(followed(step))) return false;
	}
	return held(followed(named));
}

/** Each of `paths` that doesn't lie, all the way, inside one of `roots`. */
function outsideOf(
	paths: readonly string[],
	roots: readonly (string | null)[],
): string[] {
	return paths.filter((path) => !heldAllTheWay(path, roots));
}

/** What the gate reads, each its own so a test can say where it lies. */
export interface Places {
	readonly root: string | null;
	readonly own: string;
	readonly harness: () => string | undefined;
	/** The other places a registered default may lie, the install aside. */
	readonly held?: readonly string[];
	/** The Nix store, where this session's own harness may lie too. */
	readonly store?: string;
	/** Whether this account could change a path, as `canChange` asks. */
	readonly changeable?: (path: string) => boolean;
}

/** Where things lie on this machine, read as the gate asks. */
export function placesHere(): Places {
	return {
		root: installedPackages(),
		own: packageRoot(),
		harness: settingsHarness,
		held: heldElsewhere(),
	};
}

/**
 * Why children of a fenced session can't start, or nothing: this
 * package runs from outside the install and the Nix store, an
 * extension registered as every child's default lies outside every held
 * place, or, for an unisolated child, the person's settings load this
 * package from outside the install or not at all.
 */
export function fencedChildrenRefusal(
	unisolated: boolean,
	defaults: readonly string[],
	places: Places = placesHere(),
): string | undefined {
	const {
		root,
		own,
		harness,
		held = [],
		store = NIX_STORE,
		changeable = canChange,
	} = places;
	// A room runs the harness from the Nix store. Its own copy is held
	// while this account can't change it, and which copy this session
	// loaded is no command's choice. Children take their packs from that
	// same copy (fence-keep's fencePacks), not from anywhere in the store.
	if (
		!(inside(own, root) || heldStoreCopy(own, store, changeable) !== undefined)
	) {
		return `This session runs the harness from ${own}, outside ${INSTALL} and any Nix store copy this account can't change, where its fenced commands may write; each child would load this package's own files from there outside the fence. ${RELOAD}.`;
	}
	const strays = outsideOf(defaults, [root, ...held]);
	if (strays.length > 0) {
		return `An extension registered for every subagent lies where fenced commands may write, outside ${INSTALL}, pi's agent folder and the Nix store, and each child would load it outside the fence: ${strays.join(", ")}. Install the package that registers it, or start this session without it.`;
	}
	if (!unisolated) return undefined;
	const loaded = harness();
	if (loaded === undefined) {
		return `An unisolated child loads the harness from the person's settings, which name none, so its bash would be pi's plain one, run outside the fence. Name the install in pi's settings first.`;
	}
	if (!inside(loaded, root)) {
		return `An unisolated child loads the harness from the person's settings, which name ${loaded}, outside ${INSTALL}, where fenced commands may write. Point the settings at the install first.`;
	}
	return undefined;
}

/** The fence's bash, by its place in a package. */
const FENCED_BASH = join("extensions", "shell-workflow", "index.ts");

/**
 * Why an unisolated child of a fenced session can't start, or nothing:
 * an extension the person's settings load, from a package, their own
 * list or pi's agent folder, lies where a fenced command may write, or
 * none of them is the fence's bash from the install, which a package
 * filter could leave out. The settings themselves sit in pi's agent
 * folder, which the fence holds read-only, so what is read here is what
 * the child reads.
 */
export async function settingsRefusal(
	root: string | null = installedPackages(),
	loaded: () => Promise<string[]> = settingsExtensions,
	held: readonly string[] = heldElsewhere(),
): Promise<string | undefined> {
	let paths: string[];
	try {
		paths = await loaded();
	} catch (error) {
		return `An unisolated child loads every extension the person's settings name, and they couldn't be read (${error instanceof Error ? error.message : String(error)}). Ask again once pi's settings can be read.`;
	}
	const strays = outsideOf(paths, [root, ...held]);
	if (strays.length > 0) {
		return `An unisolated child loads every extension the person's settings name, and these lie where fenced commands may write, outside ${INSTALL}, pi's agent folder and the Nix store: ${strays.join(", ")}. Move them into the install or out of the settings first.`;
	}
	const fenced = paths.some((path) => {
		const real = followed(path);
		return (
			real !== undefined &&
			inside(real, root) &&
			real.endsWith(sep + FENCED_BASH)
		);
	});
	return fenced
		? undefined
		: `An unisolated child loads its bash from the person's settings, which load no fence's bash from ${INSTALL}, so its commands would run outside the fence. Load the harness's shell-workflow from the install in pi's settings first.`;
}

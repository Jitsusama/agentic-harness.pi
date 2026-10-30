/**
 * Pointing pi's entry for this package at a tree, for one reload.
 *
 * pi tells packages apart by where they come from: a git package by
 * its URL, a local one by its absolute path. A tree added beside the
 * install would load as a second package, and every tool and command
 * would be registered twice. So a reload onto a tree replaces the
 * install's own entry in the personal settings, reloads, and puts the
 * entry back. Settings name the tree only while the reload reads them.
 *
 * Both writes go through pi's `SettingsManager`, which takes a lock and
 * writes only the fields it changed, so a model chosen in another
 * session at the same moment survives.
 *
 * pi takes that lock to read the settings too, gives up after about
 * 200 ms, and then hands back no settings at all, saying so only in its
 * errors. When the install moves, every session following it reloads at
 * once and reads them together, and on 30 October that read empty: a
 * session said its settings named no install. So a read that pi says
 * failed is tried again, and one that still fails is thrown, never taken
 * for an empty list.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DefaultPackageManager,
	getAgentDir,
	type PackageSource,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** The personal package list, read fresh each time and written back whole. */
export interface PackageSettings {
	/** The packages the personal settings name, as they are on disk now. */
	read(): PackageSource[];
	/** Write the personal package list, waiting until it is on disk. */
	write(packages: PackageSource[]): Promise<void>;
	/** Where an entry's package lives on disk, if it is installed. */
	rootOf(source: string): string | undefined;
}

/** Where a package entry comes from, whichever form it is written in. */
export function sourceOf(entry: PackageSource): string {
	return typeof entry === "string" ? entry : entry.source;
}

/** The same entry, loading from somewhere else, its filters kept. */
function pointedAt(entry: PackageSource, source: string): PackageSource {
	return typeof entry === "string" ? source : { ...entry, source };
}

/** The `name` in a package root's manifest. */
export function packageName(root: string): string | undefined {
	try {
		const manifest: unknown = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		);
		if (typeof manifest !== "object" || manifest === null) return undefined;
		return "name" in manifest && typeof manifest.name === "string"
			? manifest.name
			: undefined;
	} catch {
		// No manifest, or one that does not parse: not a package.
		return undefined;
	}
}

/** How long to wait before each further try at settings pi couldn't read. */
const READ_PAUSES_MS = [50, 100, 200, 400] as const;

/** Waits `ms` without yielding, since the settings are read synchronously. */
function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * pi's settings for `agentDir`, read whole: tried again while pi says the
 * personal settings couldn't be read, and thrown when they still can't.
 */
function readSettings(agentDir: string): SettingsManager {
	let failure = "";
	for (const wait of [0, ...READ_PAUSES_MS]) {
		if (wait > 0) pause(wait);
		// The cwd is only where pi would look for project settings; the
		// agent dir has none, so nothing from a project leaks into the list.
		const settings = SettingsManager.create(agentDir, agentDir);
		const global = settings
			.drainErrors()
			.find((error) => error.scope === "global");
		if (global === undefined) return settings;
		failure = global.error.message;
	}
	throw new Error(`pi's settings couldn't be read: ${failure}`);
}

/** The personal settings of the pi this process runs. */
export function piPackageSettings(agentDir = getAgentDir()): PackageSettings {
	// Where a package is installed comes from its source and the agent
	// dir, so the settings the last read made serve, and asking takes no
	// lock of its own.
	let last: SettingsManager | undefined;
	const read = () => {
		last = readSettings(agentDir);
		return last;
	};
	return {
		read: () => [...(read().getGlobalSettings().packages ?? [])],
		write: async (packages) => {
			const settings = read();
			settings.setPackages(packages);
			await settings.flush();
		},
		rootOf: (source) =>
			new DefaultPackageManager({
				cwd: agentDir,
				agentDir,
				settingsManager: last ?? read(),
			}).getInstalledPath(source, "user"),
	};
}

/** Where in the list the entry for the package called `name` is, or -1. */
export function entryFor(
	settings: PackageSettings,
	packages: readonly PackageSource[],
	name: string,
): number {
	return packages.findIndex((entry) => {
		const root = settings.rootOf(sourceOf(entry));
		return root !== undefined && packageName(root) === name;
	});
}

/** Where the configured entry for the package `name` is installed, if any. */
export function installRoot(
	settings: PackageSettings,
	name: string,
): string | undefined {
	const packages = settings.read();
	const index = entryFor(settings, packages, name);
	const entry = packages[index];
	return entry === undefined ? undefined : settings.rootOf(sourceOf(entry));
}

/** Puts the entry back. Says false when somebody changed it meanwhile and it was left alone. */
export type Restore = () => Promise<boolean>;

/**
 * Point the entry for package `name` at `tree`, and return the way back.
 *
 * Refuses, by throwing, when the settings name no entry for the
 * package (pi was started with `-e`) or `tree` is not that package.
 */
export async function pointEntryAt(
	settings: PackageSettings,
	name: string,
	tree: string,
): Promise<Restore> {
	if (!existsSync(tree) || packageName(tree) !== name) {
		throw new Error(`${tree} is not a checkout of ${name}.`);
	}
	const packages = settings.read();
	const index = entryFor(settings, packages, name);
	const original = packages[index];
	if (original === undefined) {
		throw new Error(
			`pi's settings name no package entry for ${name}, so there is nothing to point at the tree. Start pi with \`-e ${tree}\` instead.`,
		);
	}
	packages[index] = pointedAt(original, tree);
	await settings.write(packages);
	return async () => {
		const now = settings.read();
		const at = now.findIndex((entry) => sourceOf(entry) === tree);
		const swapped = now[at];
		if (swapped === undefined) return false;
		now[at] = pointedAt(swapped, sourceOf(original));
		await settings.write(now);
		return true;
	};
}

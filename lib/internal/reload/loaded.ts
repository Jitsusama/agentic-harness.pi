/**
 * Which code this session is running, said plainly.
 *
 * A reload is only useful when everybody knows what it loaded. The
 * agent once fired a gate before its owner had reloaded, and assumed a
 * new session when he had; a month of merged fixes reached almost no
 * session because nothing said the running code was old. So every
 * reload ends by saying where the code came from, at which commit, and
 * whether that is the install pi's settings name.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** How long one git call may take before it is given up on. */
const GIT_TIMEOUT_MS = 2_000;

/** How many characters of a commit to show. */
const SHORT_SHA = 12;

/** What runs, and against what the settings name. */
export interface Loaded {
	/** The package root this code was loaded from. */
	readonly root: string;
	/** Its HEAD, when it is a checkout. */
	readonly head?: string;
	/** How many files differ from HEAD, when it is a checkout. */
	readonly uncommitted?: number;
	/** Where the settings' entry for this package is installed, if they name one. */
	readonly install?: string;
}

/**
 * The install a release folder belongs to: a package installed whole
 * into `<install>/releases/<commit>` and named by a `current` link
 * beside them (core.nix's pi-packages), or nothing for any other folder.
 */
export function releasesOf(root: string): string | undefined {
	const parent = dirname(root);
	return basename(parent) === "releases" ? dirname(parent) : undefined;
}

/**
 * Whether the session runs something other than the install its settings
 * name. A release the install's link has since left is still the install,
 * only behind it: the session follows it, rather than being held as one
 * running a tree on purpose.
 */
export function isSwapped(loaded: Pick<Loaded, "root" | "install">): boolean {
	if (loaded.install === loaded.root) return false;
	if (loaded.install === undefined) return true;
	const releases = releasesOf(loaded.root);
	return releases === undefined || releases !== releasesOf(loaded.install);
}

function git(
	root: string,
	args: readonly string[],
): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", root, ...args],
			{ timeout: GIT_TIMEOUT_MS },
			(error, stdout) => resolve(error ? undefined : stdout),
		);
	});
}

/** Read what `root` is, from git, beside where the settings install it. */
export async function readLoaded(
	root: string,
	install: string | undefined,
): Promise<Loaded> {
	const base = install === undefined ? { root } : { root, install };
	if (!existsSync(join(root, ".git"))) return base;
	const [head, status] = await Promise.all([
		git(root, ["rev-parse", "HEAD"]),
		git(root, ["status", "--porcelain"]),
	]);
	return {
		...base,
		...(head?.trim() ? { head: head.trim() } : {}),
		...(status === undefined
			? {}
			: { uncommitted: status.split("\n").filter(Boolean).length }),
	};
}

/** A path with the home directory written as `~`. */
export function homely(path: string, home = homedir()): string {
	return path === home || path.startsWith(`${home}/`)
		? `~${path.slice(home.length)}`
		: path;
}

/** "at <sha>, with N uncommitted changes", or as much of it as is known. */
function revision(loaded: Loaded): string {
	if (loaded.head === undefined) return "";
	const changes =
		loaded.uncommitted === undefined || loaded.uncommitted === 0
			? ""
			: `, with ${loaded.uncommitted} uncommitted ${loaded.uncommitted === 1 ? "change" : "changes"}`;
	return ` at ${loaded.head.slice(0, SHORT_SHA)}${changes}`;
}

/** One sentence saying what runs, for the model and for the person. */
export function describeLoaded(name: string, loaded: Loaded): string {
	const where = homely(loaded.root);
	if (!isSwapped(loaded)) {
		return `${name} runs its install, ${where}${revision(loaded)}.`;
	}
	const install =
		loaded.install === undefined
			? "pi's settings name no install of it"
			: `the install is ${homely(loaded.install)}`;
	return `${name} runs ${where}${revision(loaded)}, not its install: ${install}.`;
}

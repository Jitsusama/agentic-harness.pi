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
import { headFromFiles } from "./head.ts";

/**
 * The custom message a reload nobody asked the agent for is said in,
 * which the spend ledger reads as a reload between two turns.
 */
export const LOADED_MESSAGE = "harness-loaded";

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
 * The folders an installed version sits in: `versions/`, and `releases/`,
 * where core.nix's pi-packages kept them until that word was left to
 * giving a tree back. A session started before the move runs from the
 * second until it reloads.
 */
const VERSION_FOLDERS: ReadonlySet<string> = new Set(["versions", "releases"]);

/**
 * The install a version folder belongs to: a package installed whole
 * into `<install>/versions/<commit>` and named by a `current` link
 * beside them (core.nix's pi-packages), or nothing for any other folder.
 */
export function installOfVersion(root: string): string | undefined {
	const parent = dirname(root);
	return VERSION_FOLDERS.has(basename(parent)) ? dirname(parent) : undefined;
}

/**
 * Whether the session runs something other than the install its settings
 * name. A version the install's link has since left is still the install,
 * only behind it: the session follows it, rather than being held as one
 * running a tree on purpose.
 */
export function isSwapped(loaded: Pick<Loaded, "root" | "install">): boolean {
	if (loaded.install === loaded.root) return false;
	if (loaded.install === undefined) return true;
	const install = installOfVersion(loaded.root);
	return install === undefined || install !== installOfVersion(loaded.install);
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

/** What a checkout says of itself: its commit and how many files differ from it. */
type Checkout = Pick<Loaded, "head" | "uncommitted">;

/** Each checkout's reading, by its root, once per load of this code. */
const checkouts = new Map<string, Promise<Checkout>>();

/**
 * Read what `root` is, from git, beside where the settings install it.
 *
 * A checkout is read once per load of this code, since the reading
 * says what this load runs, and what changes on disk after it runs in
 * none of it until a reload, which loads this module afresh. Every
 * conversation a host starts or wakes asks, and each git it started was
 * forked from the loop the others wait on: 459 ms of one turn in a soak
 * of twelve (13 November). HEAD is read from git's files; only the
 * count of what differs asks git, that once.
 */
export async function readLoaded(
	root: string,
	install: string | undefined,
): Promise<Loaded> {
	const base = install === undefined ? { root } : { root, install };
	if (!existsSync(join(root, ".git"))) return base;
	let reading = checkouts.get(root);
	if (reading === undefined) {
		reading = readCheckout(root);
		checkouts.set(root, reading);
	}
	return { ...base, ...(await reading) };
}

async function readCheckout(root: string): Promise<Checkout> {
	const [head, status] = await Promise.all([
		headFromFiles(root) ?? git(root, ["rev-parse", "HEAD"]),
		git(root, ["status", "--porcelain"]),
	]);
	return {
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

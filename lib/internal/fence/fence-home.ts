/**
 * What in the home folder runs code as the person later, which the
 * agent fence (`fence.ts`) keeps read-only inside: the settings and
 * startup files, programs' entries whose settings name a command, the
 * caches within them it binds back writable, and the programs it gives
 * a home of their own. Kept apart from the fence's mounts, since this
 * list grows with each program found reading such a file, and the
 * mounts change only with how bubblewrap is driven.
 */

import { isAbsolute, join, relative, sep } from "node:path";
import {
	NAMED_HOME_DEPTH,
	namedRepositoryHomes,
} from "./fence-repository-homes.ts";

/**
 * The person's files that run code as them later, or say what does,
 * read-only inside: the shell's startup files, every program's settings
 * (systemd's units and quickshell's code among them), git's and npm's,
 * SSH's, what is on their path (their own bin, the Nix profile, dev's
 * toolchain), the launcher's entries, direnv's allow list, pi's own
 * settings and packages, the fence's own `wl-copy` and `wl-paste`, first
 * on every fenced command's path, and the skills and settings every agent loads.
 * Among programs' own entries, those read as the person later (ISXEG8,
 * 12 November): dbus's services, nvim's site plugins, the browser's
 * certificates, kubectl's and aws's settings, whose credential commands
 * run at their next call, gpg's agent settings, gradle's init scripts,
 * docker's plugins, and cargo's settings and the sources it extracted,
 * which it never checks again before building them; and rustup's
 * toolchains, whose binaries its proxies run, the browser's native
 * messaging hosts, each naming a program it runs, and bundler's
 * settings and plugins (ISXEG8, 12 November, again). And pi's state,
 * every realm's, which sessions trust for who wrote it: the steer
 * inboxes, where a file saying it is Joel's could pause, stop or move
 * another session, and the mesh's store, where a message could claim
 * any peer's address (KP0L6A, DJT4LK, 765QSB, 13 November); the session
 * records, whose environment a reopened session starts with, so one
 * saying PI_SANDBOX=off would start it unfenced; and away mode, the
 * fleets' ledger the work broker grants trees by, the looks put before
 * Joel and the sessions reopened after a reboot (85PKB2, 14 November).
 * pi itself, the launcher and the node write it from outside the fence;
 * the work broker's trees are bound back as `fence-broker-trees.ts`
 * says, so a session still writes its own. pi's state holds node's
 * compile caches too, whose entries run as compiled code at the next
 * start of a host or pi. And the two folders node's `require` searches
 * last, `.node_modules` and `.node_libraries`, where a module a pi
 * process reaches for and doesn't ship, such as ws's optional
 * `bufferutil`, would be loaded from outside the fence (04TNWT, 19
 * November). And the `node_modules` folders node searches above the
 * code pi loads from the home folder (its packages, its agent folder
 * and its state), which it reaches before those two: an empty folder
 * of the fence's making where there was none. The home folder's own
 * `node_modules`, last of them, is made by nobody: the read-only home
 * keeps one from being made, and keeps one already there read-only.
 *
 * The home folder itself is read-only too, with every other hidden
 * entry in it bound back writable, since a dotfile is often a link into
 * the store: one a command could delete, and put a file of its own in
 * its place, if it could write the folder holding it. So a top entry
 * here can't be made by a command where it isn't. Each deeper one is a
 * folder, made before the fence where its top entry is there, so it
 * can always be bound read-only.
 */
export const READ_ONLY = [
	".config",
	".zshrc",
	".zshenv",
	".zprofile",
	".zlogin",
	".profile",
	".bashrc",
	".bash_profile",
	".gitconfig",
	".npmrc",
	".ssh",
	".agents",
	".claude",
	".claude-personal",
	".claude.json",
	".codex",
	".pki",
	".kube",
	".aws",
	".gnupg",
	".gradle",
	".docker",
	".cargo",
	".rustup",
	".mozilla",
	".bundle",
	".local/bin",
	".local/share/dbus-1",
	".local/share/nvim",
	".local/share/applications",
	".local/share/direnv/allow",
	".local/share/systemd",
	".local/share/pi-packages",
	".local/share/pi-fence",
	".local/state/nix",
	".local/state/tec/toolchain",
	".local/state/pi",
	// A machine's node judges each carry by its claims and the fences it
	// has seen, kept here, which the Mac's fence hides outright.
	".local/state/mycelium",
	".pi/agent",
	".node_modules",
	".node_libraries",
	".pi/node_modules",
	".local/node_modules",
	".local/share/node_modules",
	".local/state/node_modules",
	"node_modules",
] as const;

/**
 * The start of the names of the home folder's files that run code as
 * the person later and are named for the machine: zsh's completion
 * dump and its compiled copy, which every new shell's `compinit -C`
 * sources without checking.
 */
const READ_ONLY_NAMED = [".zcompdump"] as const;

/**
 * Programs' caches within a read-only entry, bound back writable: the
 * entry's settings run code, but a cache only saves a call. A folder
 * among them (a trailing `/`) is made before the fence, whose entry
 * holding it is read-only inside, when that entry is there.
 */
const CACHES_WITHIN = [
	".kube/cache/",
	".kube/http-cache/",
	".bundle/cache/",
] as const;
// Not GKE's token cache nor aws's SSO and CLI caches: each holds a token
// of the person's own cloud login, which the fence never hands in, so
// they are hidden (data/fence-hidden.json, ISXEG8, 21 November).

/**
 * The programs given a home of their own in the fence's folder
 * (`fenceFolders`) rather than theirs in the home folder, read-only inside, since they write
 * there as they work: cargo's registry and gradle's caches. The
 * person's cargo settings still apply, read as an ancestor's, and
 * cargo's home starts with copies of what the person's cargo fetched
 * (`fence-seed.ts`).
 */
export const OWN_HOMES = [
	["CARGO_HOME", "cargo"],
	["GRADLE_USER_HOME", "gradle"],
] as const;

/** The folder the agent fence keeps its commands' own state in. */
const FENCE_FOLDER = ".cache/pi-fence";

/**
 * Where the agent fence keeps what its commands write as their own:
 * `homes`, where each of `OWN_HOMES` lives, and `gcloud`, each session's
 * settings folder. They lie apart from the strict sandbox's folders
 * (`../sandbox/strict-rules.ts`), which strict commands can write: cargo
 * reads its settings from its home and gradle runs the scripts in its
 * own, so a strict command, which reads a stranger's text, could
 * otherwise leave a program the fence's next cargo or gradle would run.
 */
export function fenceFolders(home: string): {
	homes: string;
	gcloud: string;
} {
	return {
		homes: join(home, FENCE_FOLDER, "homes"),
		gcloud: join(home, FENCE_FOLDER, "gcloud"),
	};
}

/** Each of `CACHES_WITHIN` in the home folder `home`. */
export function cachesWithin(home: string): string[] {
	return CACHES_WITHIN.map((cache) => join(home, cache.replace(/\/$/, "")));
}

/**
 * The folders made before the fence, in the home folder `home`, where
 * their top entry is there: each deeper read-only path, and each folder
 * among the caches. Inside, nothing could make one, so a read-only path
 * not yet there could otherwise be made by a command, and aws fails
 * rather than skip a cache it can't write.
 */
export function foldersMadeFirst(home: string): string[] {
	return [
		...READ_ONLY.filter((path) => path.includes("/")),
		...CACHES_WITHIN.filter((cache) => cache.endsWith("/")),
	].map((path) => join(home, path.replace(/\/$/, "")));
}

/** Whether the home folder's entry `entry` is one `READ_ONLY` names, whole or by the start of its name. */
export function readOnlyEntry(entry: string): boolean {
	return (
		READ_ONLY.some((path) => path === entry) ||
		READ_ONLY_NAMED.some((start) => entry.startsWith(start))
	);
}

/** The read-only paths, for the home folder `home`. */
export function readOnlyPaths(home: string): string[] {
	return READ_ONLY.map((path) => join(home, path));
}

/**
 * Folders that may hold repositories, and how many levels down: the
 * home folder's own entries, `src` as deep as `src/github.com/org/repo`
 * and a level more, and `world`. `src` and `world` are kept read-only
 * inside, so no command can make a repository there, and only theirs
 * count as guarded: a command can still make a git folder in a hidden
 * entry of the home folder, or the browsed one its session works in,
 * and write its settings before the fence ever guards them.
 */
export const REPOSITORY_HOMES = [
	{ where: "", depth: 1, kept: false },
	{ where: "src", depth: 4, kept: true },
	{ where: "world", depth: 1, kept: true },
] as const;

/** A folder that may hold repositories, how deep, and whether it is kept read-only. */
export interface RepositoryHome {
	readonly top: string;
	readonly depth: number;
	readonly kept: boolean;
}

/**
 * Every repository home for the home folder `home`: its own, then each
 * the person's settings name outside it (`fence-repository-homes.ts`),
 * laid out as `src` is and kept read-only as it is.
 */
export function repositoryHomes(
	home: string,
	named: readonly string[] = namedRepositoryHomes(home),
): RepositoryHome[] {
	return [
		...REPOSITORY_HOMES.map(({ where, depth, kept }) => ({
			top: join(home, where),
			depth,
			kept,
		})),
		...named.map((top) => ({ top, depth: NAMED_HOME_DEPTH, kept: true })),
	];
}

/**
 * The repository home kept read-only that `folder` lies in outside any
 * repository's work, as `src`, `src/github.com/org` or a plain folder
 * at any depth does, or inside a git folder: a command written there
 * could write the git settings of a repository below it, or make one
 * the fence would then take as guarded. Nothing where it lies in a
 * repository's work, or in no kept home. `isRepository` says whether a
 * folder is one, as a `.git` in it says. `fold` spells a path as the
 * volume compares it (lowered on a Mac), used only to compare: the
 * folders are asked about as they are spelled.
 */
export function keptHomeAbove(
	folder: string,
	home: string,
	isRepository: (folder: string) => boolean,
	fold: (path: string) => string = (path) => path,
): string | undefined {
	for (const { top, kept } of repositoryHomes(home)) {
		if (!kept) continue;
		const at = relative(fold(top), fold(folder));
		if (at.startsWith(`..${sep}`) || at === ".." || isAbsolute(at)) continue;
		const depth = at === "" ? 0 : at.split(sep).length;
		const parts = depth === 0 ? [] : folder.split(sep).slice(-depth);
		if (parts.some((part) => fold(part) === ".git")) return top;
		let each = top;
		const inRepository =
			isRepository(top) ||
			parts.some((part) => {
				each = join(each, part);
				return isRepository(each);
			});
		if (!inRepository) return top;
	}
	return undefined;
}

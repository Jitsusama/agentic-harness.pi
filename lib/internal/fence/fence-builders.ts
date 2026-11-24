/**
 * The builders' runtime folders inside the fence: read-only, and without
 * the cloud token. Each of nix-offload's lenders (/run/nix-offload, -more,
 * -vm, -vm-3 and on, made as demand grows) holds a copy of Joel's own
 * Google Cloud access token, rewritten every two minutes, full
 * cloud-platform scope, for root's lines service to ask about lent
 * builders (5FWIUS [973d1bc1], [d4798747]); whoever holds it can do
 * anything his cloud identity can. No fenced command reads the token:
 * Nix finds its builders in /run/nix-offload-lines, and `nix-offload
 * there` runs outside.
 *
 * Each lender's folder there when a command starts is covered by an
 * empty one with every other entry bound back read-only. The token is
 * never bound, rather than bound over: the lender replaces it whole, and
 * replacing a file another namespace has a bind over detaches that bind,
 * so a command running past the next rotation would read the new token.
 * A folder's cover isn't detached by what happens inside it. An entry
 * replaced while a command runs shows its cover's empty stand-in until
 * the next command. A lender made while a command runs isn't covered for
 * it, which a single folder for every token, made by root, closes:
 * /run/nix-offload-tokens, a file a lender (5FWIUS [8b62b8aa]), hidden
 * whole, since everything in it is a token.
 *
 * A strict command (Landlock, through landrun) is given what nix-offload
 * reads and writes the same way, as paths rather than binds: on 24
 * November one in the strict sandbox was refused /run/nix-offload/lender
 * and its own journal, so `nix-offload there` said no builder was lent
 * while 18 were (80ECO2 [9b5c1cda]). A folder holding no secret is given
 * whole, since Landlock ties a file's grant to the file as it was when
 * the command started, and a lender replaces its files as it goes. One
 * holding a secret is given entry by entry, the secret left out.
 */

import { basename, join } from "node:path";
import type { Disk } from "./fence-disk.ts";

/** Where the lenders' folders are. */
const RUN = "/run";

/** A lender's folder's name: nix-offload, or nix-offload and a suffix. */
const LENDER = /^nix-offload(-[\w-]+)?$/;

/** Folders named alike that hold no token: root's lines and standing builders. */
const NO_TOKEN: ReadonlySet<string> = new Set([
	"nix-offload-lines",
	"nix-offload-standing",
]);

/** The folder holding every lender's token, a file named for its lender. */
const TOKENS = "nix-offload-tokens";

/** What in a lender's folder no fenced command may read. */
const SECRETS: ReadonlySet<string> = new Set(["cloud-token"]);

/** Where nix-offload puts each run's want, which every run writes. */
const WANTS = "offload-wants";

/** nix-offload's own state in the home folder: its journal, passes and runs. */
const STATE = ".local/state/nix-offload";

/** What in nix-offload's state no strict command may read: its store's signing key. */
const STATE_SECRETS: ReadonlySet<string> = new Set(["store_ed25519"]);

/** Whether `name`, in /run, is a lender's folder. */
function isLender(name: string): boolean {
	return LENDER.test(name) && !NO_TOKEN.has(name);
}

/** The lenders' folders there now. */
export function lenderFolders(disk: Disk, run: string = RUN): string[] {
	return [...disk.entries(run)]
		.filter(isLender)
		.sort()
		.map((name) => join(run, name))
		.filter((folder) => disk.kind(folder) === "folder");
}

/**
 * bubblewrap's arguments covering each lender's folder, with every entry
 * but the secrets bound back read-only.
 */
export function buildersFolderArgs(
	disk: Disk,
	folders: readonly string[] = lenderFolders(disk),
): string[] {
	return folders.flatMap((folder) => {
		const tokens = basename(folder) === TOKENS;
		const kept = [...(tokens ? [] : disk.entries(folder))]
			.filter((name) => !SECRETS.has(name))
			.sort()
			.flatMap((name) => {
				const path = join(folder, name);
				const kind = disk.kind(path);
				return kind === "file" || kind === "folder"
					? ["--ro-bind", path, path]
					: [];
			});
		return ["--tmpfs", folder, ...kept, "--remount-ro", folder];
	});
}

/** What a strict command may read and write of the builders. */
export interface BuildersReach {
	readonly readable: readonly string[];
	readonly writable: readonly string[];
}

/**
 * What a strict command needs of the builders to run `nix-offload`:
 * root's lines and standing builders, each lender's folder but its
 * token, and the folder of tokens never; the wants to write, and
 * nix-offload's state but its signing key.
 */
export function buildersReach(
	disk: Disk,
	home: string,
	run: string = RUN,
): BuildersReach {
	const lenders = lenderFolders(disk, run).filter(
		(folder) => basename(folder) !== TOKENS,
	);
	return {
		readable: [
			...[...NO_TOKEN].sort().map((name) => join(run, name)),
			...lenders.flatMap((folder) => keptOf(disk, folder, SECRETS)),
		],
		writable: [
			join(run, WANTS),
			...keptOf(disk, join(home, STATE), STATE_SECRETS),
		],
	};
}

/**
 * `folder` whole when it holds none of `secrets`, or else each of its
 * files and folders but those, so a secret is never in reach.
 */
function keptOf(
	disk: Disk,
	folder: string,
	secrets: ReadonlySet<string>,
): string[] {
	const names = disk.entries(folder);
	if (!names.some((name) => secrets.has(name))) return [folder];
	return names
		.filter((name) => !secrets.has(name))
		.sort()
		.map((name) => join(folder, name))
		.filter((path) => {
			const kind = disk.kind(path);
			return kind === "file" || kind === "folder";
		});
}

/** The lender's folder's name `path` lies in, if it lies in one. */
function lenderOf(path: string): string | undefined {
	if (!path.startsWith(`${RUN}/`)) return undefined;
	const name = path.slice(RUN.length + 1).split("/")[0] ?? "";
	return isLender(name) ? name : undefined;
}

/** Whether pi's file tools refuse `path` to a fenced session as a lender's secret. */
export function buildersSecret(path: string): boolean {
	const name = lenderOf(path);
	if (name === TOKENS) return true;
	return (
		name !== undefined &&
		[...SECRETS].some((secret) => path === join(RUN, name, secret))
	);
}

/** Whether pi's file tools refuse writing `path` as within a lender's folder. */
export function inBuildersFolder(path: string): boolean {
	return lenderOf(path) !== undefined;
}

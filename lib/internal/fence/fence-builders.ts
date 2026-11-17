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

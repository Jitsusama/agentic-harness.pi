/**
 * The builders' runtime folder inside the fence: read-only, and without
 * the cloud token. nix-offload's lender writes Joel's own Google Cloud
 * access token there every two minutes, full cloud-platform scope, for
 * root's lines service to ask about lent builders (5FWIUS [973d1bc1]);
 * whoever holds it can do anything his cloud identity can. No fenced
 * command reads the token: Nix finds its builders in
 * /run/nix-offload-lines, and `nix-offload there` runs outside.
 *
 * The folder is covered by an empty one with every other entry bound
 * back read-only. The token is never bound, rather than bound over: the
 * lender replaces it whole, and replacing a file another namespace has
 * a bind over detaches that bind, so a command running past the next
 * rotation would read the new token. A folder's cover isn't detached by
 * what happens inside it. An entry replaced while a command runs shows
 * its cover's empty stand-in until the next command.
 */

import { join } from "node:path";
import type { Disk } from "./fence-disk.ts";

/** The builders' runtime folder, which the user unit's lender writes. */
export const BUILDERS_FOLDER = "/run/nix-offload";

/** What in it no fenced command may read. */
const SECRETS: ReadonlySet<string> = new Set(["cloud-token"]);

/**
 * bubblewrap's arguments covering the builders' folder, with every entry
 * but the secrets bound back read-only, when the folder is there.
 */
export function buildersFolderArgs(
	disk: Disk,
	folder: string = BUILDERS_FOLDER,
): string[] {
	if (disk.kind(folder) !== "folder") return [];
	const kept = [...disk.entries(folder)]
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
}

/** Whether pi's file tools refuse `path` to a fenced session as the builders' secret. */
export function buildersSecret(path: string): boolean {
	return [...SECRETS].some((name) => path === join(BUILDERS_FOLDER, name));
}

/** Whether pi's file tools refuse writing `path` as within the builders' folder. */
export function inBuildersFolder(path: string): boolean {
	return path === BUILDERS_FOLDER || path.startsWith(`${BUILDERS_FOLDER}/`);
}

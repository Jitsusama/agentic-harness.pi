/**
 * Where pi and its host keep node's compile cache: a folder of the
 * login's runtime folder on Linux, which every fenced command's root
 * empties, and else a folder of pi's state, which the fence holds
 * read-only. node reads a cached entry back as compiled code at its
 * next start, outside the fence, so a cache a fenced command could
 * write would run its code there. Left to itself, node keeps the cache
 * in the temporary folder, which is either the real `/tmp` or, for a
 * session on a quest, a folder inside the quest's scratch that the
 * fence lets that session write (04TNWT, 19 November).
 *
 * The runtime folder is a tmpfs. A host writes its cache on its thread
 * as it starts, and on 21 November the attended host's thread held 50 s
 * renaming about 1,900 entries into pi's state while btrfs's root lock
 * was contended; in memory a flush waits on no disk. It empties at each
 * reboot, which costs one cold start. A runtime folder that isn't the
 * login's own and private, is reached through a link, or lies in the
 * home folder, is passed over for pi's state, as is any platform but
 * Linux: only Linux's fence empties the runtime folder, and a home
 * folder's binds are laid back over it.
 */

import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { SessionEnvironment } from "../../core/session/host.ts";
import { stateDir } from "../paths.ts";

/** The variable node reads its compile cache's folder from. */
export const COMPILE_CACHE_VARIABLE = "NODE_COMPILE_CACHE";

/** The folder of the runtime folder that pi's compile caches share. */
export const RUNTIME_COMPILE = "pi-compile";

/** Whose compiled code a folder keeps: a pi host's, or every pi's node. */
export type CompiledBy = "host" | "node";

/** Each one's folder in pi's state, where it lies without a runtime folder. */
const IN_STATE: Record<CompiledBy, string> = {
	host: "host-compile",
	node: "node-compile-cache",
};

/** Owner, group and others' bits beyond the owner's own. */
const SHARED_BITS = 0o077;

/** Only the owner may enter, list or write. */
const PRIVATE_MODE = 0o700;

/**
 * Each one's folder in the login's runtime folder, when `env` names an
 * absolute one, whether or not it could be used: the folders strict
 * and pi's file tools refuse as a command's own.
 */
export function runtimeCompileFolders(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const root = env.XDG_RUNTIME_DIR;
	if (!root || !isAbsolute(root)) return [];
	return (["host", "node"] as const).map((by) =>
		join(root, RUNTIME_COMPILE, by),
	);
}

/**
 * The folder `by`'s compile cache is kept in: its folder in the runtime
 * folder, made private, on Linux, outside the home folder, when each
 * level from the runtime folder down is a folder of this login's own,
 * open to nobody else and reached through no link; its folder in pi's
 * state otherwise.
 */
export function compileFolderOf(
	by: CompiledBy,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	const root = env.XDG_RUNTIME_DIR;
	if (
		platform === "linux" &&
		root &&
		isAbsolute(root) &&
		!insideHome(root, env.HOME || homedir())
	) {
		const shared = join(root, RUNTIME_COMPILE);
		const own = join(shared, by);
		if (isPrivate(root) && madePrivate(shared) && madePrivate(own)) return own;
	}
	return stateDir(IN_STATE[by]);
}

/** The folder every pi process compiles into. */
export function compileCacheFolder(): string {
	return compileFolderOf("node");
}

/**
 * Point node's compile cache in `env` at the folder no fenced command
 * can write, so every pi this process starts, whatever its temporary
 * folder, compiles there.
 */
export function keepCompileCacheOutOfReach(
	env: Pick<SessionEnvironment, "set">,
): void {
	env.set(COMPILE_CACHE_VARIABLE, compileCacheFolder());
}

/** Whether `folder` is the home folder or lies within it. */
function insideHome(folder: string, home: string): boolean {
	const path = relative(home, folder);
	return path === "" || !(path.startsWith("..") || isAbsolute(path));
}

/** Make `folder` private if it is missing, then whether it is private. */
function madePrivate(folder: string): boolean {
	try {
		mkdirSync(folder, { mode: PRIVATE_MODE });
	} catch {
		// Already there, or it can't be made: the look below decides.
	}
	return isPrivate(folder);
}

/** Whether `folder` is a folder, not a link, this login's own and closed to others. */
function isPrivate(folder: string): boolean {
	try {
		const seen = lstatSync(folder);
		const uid = process.getuid?.();
		return (
			seen.isDirectory() &&
			!seen.isSymbolicLink() &&
			(uid === undefined || seen.uid === uid) &&
			(seen.mode & SHARED_BITS) === 0
		);
	} catch {
		// Missing or unreadable: no place to keep compiled code.
		return false;
	}
}

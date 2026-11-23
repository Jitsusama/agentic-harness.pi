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

import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
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
 * The login's runtime folder as systemd makes it on Linux, whatever a
 * process's `XDG_RUNTIME_DIR` says: a pi started without it (from ssh
 * or cron) fences no runtime folder, yet a host's cache lies here.
 */
export function loginRuntimeFolder(
	platform: NodeJS.Platform = process.platform,
	uid: number | undefined = process.getuid?.(),
): string | undefined {
	return platform === "linux" && uid !== undefined
		? `/run/user/${uid}`
		: undefined;
}

/**
 * The login's runtime folder's compile caches, none off Linux. A `login`
 * of null names none, as a test asks.
 */
export function loginCompileRoots(
	login: string | null = loginRuntimeFolder() ?? null,
): string[] {
	return login ? [join(login, RUNTIME_COMPILE)] : [];
}

/**
 * Where compile caches may lie in a runtime folder: the one `env` names
 * when absolute, and the login's own.
 */
export function runtimeCompileRoots(
	env: NodeJS.ProcessEnv = process.env,
	login: string | null = loginRuntimeFolder() ?? null,
): string[] {
	const named = env.XDG_RUNTIME_DIR;
	const roots = [
		...(named && isAbsolute(named) ? [join(named, RUNTIME_COMPILE)] : []),
		...loginCompileRoots(login),
	];
	return [...new Set(roots)];
}

/**
 * Each one's folder in those runtime folders, whether or not it could
 * be used: the folders strict and pi's file tools refuse as a
 * command's own.
 */
export function runtimeCompileFolders(
	env: NodeJS.ProcessEnv = process.env,
	login: string | null = loginRuntimeFolder() ?? null,
): string[] {
	return runtimeCompileRoots(env, login).flatMap((root) =>
		(["host", "node"] as const).map((by) => join(root, by)),
	);
}

/**
 * The folder `by`'s compile cache is kept in: its folder in the runtime
 * folder, made private, on Linux, outside the home folder, when that is
 * the login's own (`login`) and each level from it down is a folder of
 * this login's, open to nobody else and reached through no link; its
 * folder in pi's state otherwise. Only the login's, since every pi's
 * fence lays a tmpfs over that one, where another pi's fence leaves a
 * runtime folder of a process's own open to its commands.
 */
export function compileFolderOf(
	by: CompiledBy,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	login: string | null = loginRuntimeFolder(platform) ?? null,
): string {
	const root = env.XDG_RUNTIME_DIR;
	if (
		platform === "linux" &&
		root &&
		login !== null &&
		root === login &&
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

/**
 * Whether `folder` is the home folder or lies within it, as spelled or
 * through the links either is reached by.
 */
function insideHome(folder: string, home: string): boolean {
	const within = (inner: string, outer: string) => {
		const path = relative(outer, inner);
		// `..x` is a folder within, not a way out.
		return (
			path === "" ||
			!(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
		);
	};
	return within(folder, home) || within(real(folder), real(home));
}

/** `path` through its links, or as given where it can't be resolved. */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// Missing: nothing it could be reached through.
		return path;
	}
}

/**
 * Make `folder` private if it is missing, or if it is an empty folder
 * of this login's own left open, as bubblewrap makes a fence's mount
 * point on the real runtime folder; then whether it is private. One
 * open with something in it stays as it is and is passed over, since
 * another may have put that there.
 */
function madePrivate(folder: string): boolean {
	try {
		mkdirSync(folder, { mode: PRIVATE_MODE });
	} catch {
		// Already there, or it can't be made: the look below decides.
	}
	if (!isPrivate(folder) && ownEmptyFolder(folder)) {
		try {
			chmodSync(folder, PRIVATE_MODE);
		} catch {
			// Not closed: the look below passes it over.
		}
		// Looked at again once closed, for anything put there before.
		return isPrivate(folder) && ownEmptyFolder(folder);
	}
	return isPrivate(folder);
}

/** Whether `folder` is an empty folder of this login's, not a link. */
function ownEmptyFolder(folder: string): boolean {
	try {
		const seen = lstatSync(folder);
		const uid = process.getuid?.();
		return (
			seen.isDirectory() &&
			(uid === undefined || seen.uid === uid) &&
			readdirSync(folder).length === 0
		);
	} catch {
		// Missing or unreadable: not one to close.
		return false;
	}
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

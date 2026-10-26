/**
 * Finding a terminal's binary without running anything.
 *
 * The drivers used to ask `command -v`, which is a shell builtin with
 * no binary behind it on NixOS, so every check paid a failed spawn
 * before a `which` retry answered, and a system without `which` found
 * nothing. Walking PATH in-process is cheaper and has no such hole.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Whether a path names a file this process may execute. */
export type ExecutableCheck = (path: string) => boolean;

/** The executable check against the real file system. */
export const isExecutableFile: ExecutableCheck = (path) => {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		// Missing, unreadable or not executable: not a binary we can run.
		return false;
	}
};

/**
 * The absolute path a binary resolves to, or undefined.
 *
 * An absolute `name` is taken as given when it is executable, which is
 * how a configured path is honoured. A bare name is looked up along
 * `path` in order, the way a shell would.
 */
export function resolveBinary(
	name: string,
	path: string | undefined,
	isExecutable: ExecutableCheck = isExecutableFile,
): string | undefined {
	if (isAbsolute(name)) return isExecutable(name) ? name : undefined;
	if (name.includes("/")) return undefined;
	for (const dir of (path ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

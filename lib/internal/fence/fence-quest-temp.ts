/**
 * The session's quest's `TMPDIR` link, laid back into the fence's empty
 * runtime folder, so a fenced command's `TMPDIR` leads where it does
 * outside: into its quest's scratch, and nowhere else in the runtime
 * folder.
 */

import { basename, join } from "node:path";
import { TEMP_LINK_PREFIX } from "../sandbox/quest-folders.ts";
import type { OwnFolders } from "./fence-own.ts";

/** The folder in a quest's scratch its `TMPDIR` link leads to. */
const TEMP_FOLDER = "tmp";

/**
 * Where the session's quest's `TMPDIR` link lies in `runtimeDir`, and
 * the folder it leads to, read from the scratch the sandbox already
 * named by the link's name: never from the link itself, which the fence
 * never follows. Undefined for a session on no quest.
 */
export function questTempLink(
	runtimeDir: string,
	scratch: OwnFolders | undefined,
): { link: string; target: string } | undefined {
	if (!scratch?.own) return undefined;
	return {
		link: join(runtimeDir, `${TEMP_LINK_PREFIX}${basename(scratch.own)}`),
		target: join(scratch.own, TEMP_FOLDER),
	};
}

/**
 * bubblewrap's arguments for the link, made in the fence's own runtime
 * folder, which no command inside can write: so none can plant another
 * quest's link in its place, as `/tmp` let one. Nothing for a session on
 * no quest, which has no link.
 */
export function questTempArgs(
	runtimeDir: string,
	scratch: OwnFolders | undefined,
): string[] {
	const laid = questTempLink(runtimeDir, scratch);
	return laid ? ["--symlink", laid.target, laid.link] : [];
}

/**
 * `path` as pi's file tools judge it: a path through the session's own
 * link as the path in its scratch it leads to, since the runtime folder
 * is otherwise closed to them. The link itself stays in the runtime
 * folder, so replacing it is refused as writing there is.
 */
export function pastQuestTempLink(
	path: string,
	runtimeDir: string | undefined,
	scratch: OwnFolders | undefined,
): string {
	const laid = runtimeDir ? questTempLink(runtimeDir, scratch) : undefined;
	if (!laid || !path.startsWith(`${laid.link}/`)) return path;
	return join(laid.target, path.slice(laid.link.length + 1));
}

/**
 * The session's quest's `TMPDIR` link, laid back into the fence's empty
 * runtime folder, so a fenced command's `TMPDIR` leads where it does
 * outside: into its quest's scratch, and nowhere else in the runtime
 * folder.
 */

import { basename, join } from "node:path";
import { WORKSPACE_TEMP_FOLDER } from "../../core/internal/quest/workspace.ts";
import type { OwnFolders } from "./fence-own.ts";

/**
 * The start of the name of the link a quest's `TMPDIR` is, followed by
 * its quest's id: the quest workflow's `TEMP_LINK_PREFIX`, which a
 * test holds it to, since lib reads no extension.
 */
export const TEMP_LINK_PREFIX = "pi-quest-";

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
		target: join(scratch.own, WORKSPACE_TEMP_FOLDER),
	};
}

/**
 * bubblewrap's arguments for the link, made in the fence's own runtime
 * folder. A command inside may write that folder, but it is a tmpfs of
 * that command's own, seen by nothing outside, so a link swapped there
 * reaches no other command, as one swapped in `/tmp` did; and pi's file
 * tools map the link by its name, never following it. Nothing for a
 * session on no quest, which has no link.
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
 * folder, so replacing it is refused as writing there is. This reads
 * the name alone, never where the link leads, so it is safe only beside
 * a check of the path's real place, as the file tools' refusal makes.
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

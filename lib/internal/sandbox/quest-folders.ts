/**
 * The folders a session's quest keeps on this machine, as the sandbox
 * binds them: its scratch, beside it its shared folder, and the folders
 * a fenced command's direnv trusts an `.envrc` in.
 */

import { lstatSync, mkdirSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { TEMP_LINK_PREFIX } from "../fence/fence-quest-temp.ts";
import {
	questSharesRoot,
	questWorkspacesRoot,
} from "../quest/workspace/workspace-root.ts";
import { cutTreeDir } from "../work-records.ts";
import { real } from "./tree-git.ts";

/** The folder beside the quests' scratches where carries stage (stage.ts). */
export const CARRY_STAGING = ".carrying";

/**
 * Make the scratches' root, and the staging carries keep in it, before
 * any command runs, whatever its sandbox: a root not made yet lies in
 * the cache a Mac's fence lets a command write, where it could make
 * the root, or the staging in it as a link, before a carry did. A root
 * the person made a link to elsewhere stays one. Answers nothing, and
 * one that can't be made is left for the fence and the carry to refuse.
 */
export function makeScratches(root: string = questWorkspacesRoot()): void {
	try {
		mkdirSync(root, { recursive: true });
		if (!lstatSync(join(root, CARRY_STAGING), { throwIfNoEntry: false })) {
			mkdirSync(join(root, CARRY_STAGING), { mode: 0o700 });
		}
	} catch {
		// One made meanwhile, or that can't be, is read as it stands.
	}
}

/**
 * Where quests' scratch folders live, and the one of the quest
 * `temporary` (a session's `TMPDIR`) names, if it names one: by its
 * link's name, or by where it lies in the scratches, as written. Its
 * link is never followed: it lies in `/tmp`, which a fenced command
 * writes, and swapped for one into another quest's scratch it would
 * have that scratch, and its share, bound writable (85PKB2, 19
 * November). An own folder that is a link, or isn't there, is none,
 * as is one whose name starts with a dot: no quest's id does, and the
 * staging carries keep beside the scratches is one (stage.ts), which a
 * `TMPDIR` naming it would otherwise have bound writable.
 */
export function questScratch(
	temporary: string | undefined,
	root: string = questWorkspacesRoot(),
): { root: string; own?: string } {
	const top = real(root);
	const quest = temporary ? questNamed(resolve(temporary), top, root) : "";
	if (quest === "" || quest.startsWith(".")) return { root: top };
	const own = join(top, quest);
	return isFolderItself(own) ? { root: top, own } : { root: top };
}

/** The quest `written` names, as its link or a place in the scratches, or nothing. */
function questNamed(written: string, top: string, root: string): string {
	const name = basename(written);
	if (name.startsWith(TEMP_LINK_PREFIX)) {
		return name.slice(TEMP_LINK_PREFIX.length);
	}
	for (const scratches of new Set([top, resolve(root)])) {
		const at = relative(scratches, written);
		const first = at.split(sep)[0] ?? "";
		if (first !== ".." && !isAbsolute(at)) return first;
	}
	return "";
}

/**
 * Where quests' shared folders live, and the one of the quest whose
 * scratch is `scratch`'s own, if it has one. The root itself is never
 * followed: one that is a link, as a command could leave one where none
 * was yet, leads wherever it was pointed, such as into the scratches,
 * so it is no share's, and holds no own folder.
 */
export function questShare(
	scratch: { own?: string },
	root: string = questSharesRoot(),
): { root: string; own?: string } {
	const top = join(real(dirname(root)), basename(root));
	return scratch.own && isFolderItself(top)
		? { root: top, own: join(top, basename(scratch.own)) }
		: { root: top };
}

/** Whether `path` is a folder itself, not a link to one. */
function isFolderItself(path: string): boolean {
	try {
		return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
	} catch {
		return false;
	}
}

/**
 * Make the shares' root, and `scratch`'s quest's own shared folder, before
 * any command runs, whatever its sandbox: inside a fence the root is
 * read-only and nothing could make the own folder, and a root not made
 * yet would be the writable cache's, where a fenced command could make
 * it, or a link, itself. Answers the share, as {@link questShare} reads
 * it once they are made.
 */
export function makeShares(
	scratch: { own?: string },
	root: string = questSharesRoot(),
): { root: string; own?: string } {
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
	} catch {
		// One that can't be made, or is a file, binds nothing and says
		// nothing, as `questShare` and presence read it.
	}
	const share = questShare(scratch, root);
	if (share.own) {
		try {
			mkdirSync(share.own, { recursive: true, mode: 0o700 });
		} catch {
			// Left unbound and unsaid, as one removed is.
		}
	}
	return share;
}

/**
 * The folders a fenced command's direnv trusts an `.envrc` in, by plain
 * prefix: the work tool's trees and the quests' scratches, never their
 * shared folders, which a cell on another machine writes in.
 */
export function direnvTrusts(): string[] {
	return [real(cutTreeDir()), real(questWorkspacesRoot())];
}

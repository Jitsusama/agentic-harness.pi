/**
 * Where the agent's commands put temporary files and Go's caches while
 * a quest is loaded: its workspace, which conclude removes, rather than
 * the system temp directory or the account's caches, which no quest
 * owns and so nothing reaps.
 *
 * The gate used to refuse every write to `/tmp` and name the workspace
 * instead, and 69 refusals in a week were that: one retry each, for a
 * goal nobody disputed. Setting `TMPDIR` gets the same outcome without
 * a refusal, since `mktemp` and most tools already follow it.
 *
 * `TMPDIR` is a short link in the system temp directory rather than the
 * workspace path itself, because the workspace path is about 75
 * characters and a Unix socket path may be at most 107. Tools that make
 * one under `TMPDIR` (Python's multiprocessing adds 33 characters) would
 * fail past that. The bytes still land in the workspace, where they are
 * counted and cleared, and a write through the link reads as the
 * quest's scratch, since the gate compares real paths.
 */

import {
	lstatSync,
	mkdirSync,
	readlinkSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { questWorkspace } from "../../lib/core/internal/quest/workspace.ts";
import {
	btrfsFolders,
	makeWorkspace,
	type WorkspaceFolders,
	workspaceDirOf,
} from "./workspace.ts";

/**
 * The start of every link's name, to be followed by the quest's ID.
 *
 * `pi-quest-` because disk-guard's temp pass leaves that prefix alone
 * and takes other idle names that look made up, which `pi-QEST-<id>`
 * does, since it ends in a run with digits in it. Named that way, eleven
 * links went at once under urgent disk pressure on 24 October. A
 * background job reading through one met "No such file or directory"
 * until its session's next command made the link again.
 */
export const TEMP_LINK_PREFIX = "pi-quest-";

/** Where the short link goes: `/tmp` when there is one, else the OS temp. */
function systemTemp(): string {
	try {
		// macOS's /tmp is a link to /private/tmp, which serves as well.
		const stat = lstatSync("/tmp");
		if (stat.isDirectory() || stat.isSymbolicLink()) return "/tmp";
	} catch {
		// No /tmp, as on some Windows setups; the OS temp is the next best.
	}
	return tmpdir();
}

/**
 * The link to `target` at `link`, made or repaired, or undefined when
 * something that is not our link to it already sits there. Somebody
 * else's file in a shared directory is never replaced.
 */
function linkTo(link: string, target: string): string | undefined {
	let stat: ReturnType<typeof lstatSync> | undefined;
	try {
		stat = lstatSync(link);
	} catch {
		stat = undefined;
	}
	if (stat && !stat.isSymbolicLink()) return undefined;
	if (stat && process.getuid && stat.uid !== process.getuid()) return undefined;
	if (stat && readlinkSync(link) === target) return link;
	if (stat) unlinkSync(link);
	symlinkSync(target, link);
	return link;
}

/** The variable that names the quest a command's work is for. */
export const QUEST_ENV = "PI_QUEST";

/**
 * What the loaded quest's commands carry: the quest's id, which the
 * machine reads to share CPU and disk by quest, its `TMPDIR`, and Go's
 * build and module caches in its workspace, so they go with the quest.
 * Left to themselves they sit in the account, where on 26 October they
 * held 6.4 GB that no quest owned. Cargo's needs no variable: its build
 * folder is in the project, so a tree's goes with the tree. The id
 * stays when the temp folder can't be made, since a command that keeps
 * its files elsewhere still does the quest's work.
 */
export function questCommandEnvironment(
	workspaceRoot: string,
	questId: string | null,
	linkRoot: string = systemTemp(),
): Record<string, string> | undefined {
	if (!questId) return undefined;
	let tmp: string | undefined;
	try {
		tmp = questTempDir(workspaceRoot, questId, linkRoot);
	} catch {
		tmp = undefined;
	}
	// Go's caches only beside a TMPDIR: a workspace that could not be
	// made for one could not hold them either.
	const dir = tmp ? workspaceDirOf(workspaceRoot, questId) : undefined;
	return {
		[QUEST_ENV]: questId,
		...(tmp ? { TMPDIR: tmp } : {}),
		...(dir
			? {
					GOCACHE: path.join(dir, "cache", "go-build"),
					GOMODCACHE: path.join(dir, "cache", "go-mod"),
				}
			: {}),
	};
}

/**
 * Take away a quest's short link once its workspace is gone, when it is
 * still ours and points there.
 */
export function dropTempLink(
	questId: string,
	linkRoot: string = systemTemp(),
): void {
	const link = path.join(linkRoot, `${TEMP_LINK_PREFIX}${questId}`);
	try {
		const stat = lstatSync(link);
		if (!stat.isSymbolicLink()) return;
		if (process.getuid && stat.uid !== process.getuid()) return;
		if (!readlinkSync(link).includes(questId)) return;
		unlinkSync(link);
	} catch {
		// No link, or one gone since: nothing to take away.
	}
}

/**
 * The `TMPDIR` for a quest's commands, made on first need: a short link
 * to its workspace's `tmp/`, or the `tmp/` itself when the link cannot
 * be made. Undefined for an ID that names no workspace.
 */
export function questTempDir(
	workspaceRoot: string,
	questId: string | null,
	linkRoot: string = systemTemp(),
	folders: WorkspaceFolders = btrfsFolders,
): string | undefined {
	if (!questId || !workspaceDirOf(workspaceRoot, questId)) return undefined;
	const { dir, tmp } = questWorkspace(workspaceRoot, questId);
	makeWorkspace(dir, folders);
	mkdirSync(tmp, { recursive: true });
	try {
		return (
			linkTo(path.join(linkRoot, `${TEMP_LINK_PREFIX}${questId}`), tmp) ?? tmp
		);
	} catch {
		// A temp directory we cannot write a link into still leaves the
		// workspace, whose long path is fine for everything but sockets.
		return tmp;
	}
}

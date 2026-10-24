/**
 * Where the agent's commands put temporary files while a quest is
 * loaded: its workspace's `tmp/`, which conclude clears, rather than
 * the system temp directory, which nothing reaps.
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
import { questWorkspace } from "@jitsusama/agentic-harness.core/quest/workspace";
import { workspaceDirOf } from "./workspace.ts";

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

/**
 * The `TMPDIR` for a quest's commands, made on first need: a short link
 * to its workspace's `tmp/`, or the `tmp/` itself when the link cannot
 * be made. Undefined for an ID that names no workspace.
 */
export function questTempDir(
	workspaceRoot: string,
	questId: string | null,
	linkRoot: string = systemTemp(),
): string | undefined {
	if (!questId || !workspaceDirOf(workspaceRoot, questId)) return undefined;
	const { tmp } = questWorkspace(workspaceRoot, questId);
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

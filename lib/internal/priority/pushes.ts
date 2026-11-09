/**
 * A push of World that leaves out its LFS scan when it holds no LFS file.
 *
 * A shell whose walk of World is a push runs with `core.hooksPath` set,
 * through `GIT_CONFIG_COUNT`, to a folder in the queue's where every
 * hook name runs push-hooks.mjs. That runs the repository's own hooks,
 * and for a push that adds no LFS file it leaves out the one pre-push
 * hook whose scan of a whole World tree once held a push of 4 commits
 * for over 90 minutes (see push-hooks.mjs).
 */

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeWhole } from "../write-whole.ts";
import {
	HOOK_NAMES,
	PRIOR_VARIABLE,
	SKIP_STALE_VARIABLE,
} from "./push-hooks.mjs";
import { skipsWorldPushHooks, type Where } from "./queue.ts";

/**
 * Why a push of World with `--no-verify` is refused, saying the form to
 * run instead, or nothing for any other command. A branch the
 * stale-cutoff hook refuses is rebased first; one stacked on a parent
 * feature branch, which that hook measures against main all the same,
 * leaves out that hook alone (push-hooks.mjs), never the rest.
 */
export function skippedHooksRefusal(
	command: string,
	where: Where,
): string | undefined {
	if (!skipsWorldPushHooks(command, where)) return undefined;
	return `This pushes to World with --no-verify, which skips every pre-push hook dev runs: its ancestry and stale-cutoff checks as well as the LFS scan. Run the same push without --no-verify. A push that holds no LFS file already leaves the LFS scan out, so it waits no longer for it. If the stale-cutoff check refuses an old branch, rebase it onto main first so it isn't stale any more. Only for a branch stacked on a parent feature branch, which that check still measures against main, run the same push as ${SKIP_STALE_VARIABLE}=1 git push ...: it leaves out that one check, and the LFS and ancestry hooks still run.`;
}

/** The folder in the queue's that a pushing shell takes its hooks from. */
export const PUSHES_FOLDER = "pushes";

/**
 * The hook a pushing shell's git runs as `name`: this node running
 * push-hooks.mjs, told the name, when the repository has a hook of that
 * name. It reads that in sh first, with our setting hidden, so an event
 * the repository has no hook for, as a reference-transaction on every
 * ref update is in World, starts no node. Should node or the script be
 * gone, it runs the repository's own hook as it is. A hooks folder that
 * can't be read refuses, rather than skipping the repository's hooks.
 * Nothing for a path that can't be quoted plainly.
 */
export function pushHook(
	name: string,
	node: string = process.execPath,
	script: string = fileURLToPath(new URL("./push-hooks.mjs", import.meta.url)),
): string | undefined {
	if ([node, script].some((path) => path.includes("'"))) return undefined;
	return [
		"#!/bin/sh",
		`hooks=$(GIT_CONFIG_COUNT="\${${PRIOR_VARIABLE}:-0}" git rev-parse --path-format=absolute --git-path hooks) || exit 1`,
		`[ -x "$hooks/${name}" ] || exit 0`,
		`[ -x '${node}' ] && [ -f '${script}' ] && exec '${node}' '${script}' ${name} "$@"`,
		`GIT_CONFIG_COUNT="\${${PRIOR_VARIABLE}:-0}" exec "$hooks/${name}" "$@"`,
		"",
	].join("\n");
}

/**
 * Puts a {@link pushHook} for every hook name in the queue's folder as
 * `pushes/<name>`, runnable, leaving those there as they are. Whether
 * they are all there to run: a shell given the folder with one missing
 * would skip that hook of its repository's.
 */
export function placePushHooks(dir: string): boolean {
	const folder = join(dir, PUSHES_FOLDER);
	try {
		mkdirSync(folder, { recursive: true });
	} catch {
		// Unwritable: its pushes run their hooks as they are.
		return false;
	}
	for (const name of HOOK_NAMES) {
		const wrapper = pushHook(name);
		if (wrapper === undefined) return false;
		const file = join(folder, name);
		try {
			if (readFileSync(file, "utf8") === wrapper) continue;
		} catch {
			// Not placed yet: placed below.
		}
		try {
			writeWhole(file, wrapper);
			chmodSync(file, 0o755);
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * The line a pushing shell runs before its command: `core.hooksPath`
 * set to the queue's hooks after any git settings it already holds, and
 * how many those were, so the hooks can take it off again. Nothing for
 * a folder that can't be quoted plainly.
 */
export function pushesLine(dir: string): string | undefined {
	if (dir.includes("'")) return undefined;
	const folder = join(dir, PUSHES_FOLDER);
	return [
		`if [ -x '${folder}/pre-push' ]; then`,
		`export ${PRIOR_VARIABLE}="\${GIT_CONFIG_COUNT:-0}";`,
		`export "GIT_CONFIG_KEY_$${PRIOR_VARIABLE}=core.hooksPath" "GIT_CONFIG_VALUE_$${PRIOR_VARIABLE}=${folder}";`,
		`export GIT_CONFIG_COUNT=$(( ${PRIOR_VARIABLE} + 1 ));`,
		"fi",
	].join(" ");
}

/**
 * A quest's workspace: where everything a quest makes that is not its
 * record lives, such as clones, raw data, labs, runs and builds.
 *
 * It sits outside the quests folder, under a root the adapter chooses
 * (pi's is its cache directory), in a folder named by the quest's ID, so
 * anything outside pi can find a workspace's quest by name alone. Its
 * `tmp/` takes the ad-hoc writes that would otherwise land in system
 * temp, and is the one part a conclude clears. The rest outlives the
 * quest for a while and is reclaimed by the disk guard, which also
 * compresses a concluded quest's workspace; neither is done here, since
 * both are slow and belong to the host.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isId, prefixOf } from "./id.ts";

/** A quest's workspace folder and its `tmp/`. */
export interface QuestWorkspace {
	readonly dir: string;
	readonly tmp: string;
}

/**
 * Where a quest's workspace is. Refuses anything that is not a quest's
 * ID, since the folder is created and emptied by name and a name like
 * `../x` would reach outside the root.
 */
export function questWorkspace(root: string, questId: string): QuestWorkspace {
	if (!isId(questId) || prefixOf(questId) !== "QEST") {
		throw new Error(`"${questId}" is not a quest ID.`);
	}
	const dir = join(root, questId);
	return { dir, tmp: join(dir, "tmp") };
}

/** A quest's `tmp/`, created on first need. */
export function ensureQuestWorkspaceTmp(root: string, questId: string): string {
	const { tmp } = questWorkspace(root, questId);
	mkdirSync(tmp, { recursive: true });
	return tmp;
}

/**
 * Empty a quest's `tmp/` and leave the rest of its workspace. Returns
 * whether there was one to clear. Best-effort, as reaping scratch was: a
 * wedged file must not stop a quest from concluding.
 */
export function clearQuestWorkspaceTmp(root: string, questId: string): boolean {
	const { tmp } = questWorkspace(root, questId);
	if (!existsSync(tmp)) return false;
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		// Left for the disk guard, which reclaims the whole workspace later.
	}
	return true;
}

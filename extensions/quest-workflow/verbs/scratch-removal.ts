/**
 * What sealing a quest does to its scratch: the folder here removed,
 * with what it held said, and the scratch other machines hold named,
 * since a seal can't remove that from here. Both a single seal and a
 * sweep say these.
 */

import { hostname } from "node:os";
import {
	removeQuestWorkspace,
	type WorkspaceUsers,
} from "../../../lib/core/internal/quest/workspace.ts";
import {
	duMeasure,
	formatSize,
	type Measure,
} from "../../../lib/internal/quest/footprint.ts";
import {
	machinesHoldingScratch,
	scratchElsewhereSaid,
	sharedScratchMachines,
} from "../../../lib/internal/quest/scratch-elsewhere.ts";
import type { QuestSession } from "../../../lib/quest/index.ts";
import { dropTempLink } from "../scratch.ts";
import { defaultWorkspaceRoot, workspaceDirOf } from "../workspace.ts";

/**
 * What a seal says of the quest's scratch on other machines, which it
 * can't remove from here: each machine its sessions ran on, or a share
 * copied its scratch to. Nothing when none other holds any.
 */
export function scratchLeftElsewhere(
	questId: string,
	sessions: readonly QuestSession[],
	here: string = hostname(),
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return scratchElsewhereSaid(
		machinesHoldingScratch(sessions, here, sharedScratchMachines(questId, env)),
	);
}

/**
 * How long a conclude may spend measuring the workspace it keeps.
 *
 * The largest workspace here, 19 GB, took a quarter of a second with
 * the cache warm, and all 133 took eleven seconds cold. A conclude
 * waits on this, so one slower than the deadline says "at least"
 * rather than holding it up.
 */
const CONCLUDE_MEASURE_MS = 5_000;

/**
 * Remove a sealed quest's scratch folder, its caches and builds with it,
 * and say what that freed: a cache goes with its owner, not with its
 * age. One a process or hosted conversation still works in stays for
 * the disk guard. Nothing
 * when it has no scratch folder.
 */
export async function scratchRemoved(
	questId: string | null,
	signal?: AbortSignal,
	measure: Measure = duMeasure({
		deadlineMs: CONCLUDE_MEASURE_MS,
		...(signal ? { signal } : {}),
	}),
	root: string = defaultWorkspaceRoot(),
	users?: WorkspaceUsers,
): Promise<string | undefined> {
	const dir = questId ? workspaceDirOf(root, questId) : undefined;
	if (!questId || !dir) return undefined;
	const size = await measure(dir);
	const removal = removeQuestWorkspace(root, questId, users);
	const held = size ? `, which held ${formatSize(size)}` : "";
	if (removal.removed) {
		dropTempLink(questId);
		return `Removed its scratch folder${held}.`;
	}
	if (removal.why === "in use") {
		return `Left its scratch folder${held}, since a process or a hosted conversation still works in it; the disk guard takes it once nothing does.`;
	}
	if (removal.why === "stuck") {
		return `Could not remove all of its scratch folder${held}; the disk guard takes what is left.`;
	}
	return undefined;
}

/**
 * Each quest's share of the machine, by its priority.
 *
 * A machine that sorts the agent's work into a cgroup per quest (by
 * the `PI_QUEST` every command carries) reads how heavily to weight
 * each one from `quests.json` in the shared jobs folder: quest id to a
 * cgroup weight, for every quest still open. A weight is a share, not
 * a cap, so a quest alone on the machine still gets all of it, and a
 * driving quest only gets more while others want the same CPU or disk.
 *
 * Every session writes the same file from the same quests on disk, and
 * only when it would change, so a reader watching it wakes for a real
 * change rather than for each session's look.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { machineQueueDir } from "../../lib/internal/priority/folder.ts";
import { discoverQuests } from "../../lib/internal/quest/discovery.ts";
import type { QuestPriority } from "../../lib/quest/types.ts";

/** The file in the jobs folder that holds each quest's weight. */
export const QUEST_WEIGHTS_FILE = "quests.json";

/**
 * A quest's cgroup weight by its priority. Work with no quest sits at
 * the kernel's default of 100, level with a queued quest, so a quest
 * Joel drives gets four times the share of unclaimed work and a
 * someday quest a quarter of it.
 */
export const PRIORITY_WEIGHT: Record<QuestPriority, number> = {
	driving: 400,
	active: 200,
	queued: 100,
	bench: 50,
	someday: 25,
};

/** Each open quest's weight, by id, in a stable order. */
function questWeights(questsRoot: string): Record<string, number> {
	const weights: [string, number][] = [];
	for (const [id, entry] of discoverQuests(questsRoot).index.quests) {
		const { status, priority } = entry.doc.frontMatter;
		if (status === "concluded" || status === "retired") continue;
		weights.push([id, PRIORITY_WEIGHT[priority] ?? PRIORITY_WEIGHT.queued]);
	}
	weights.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return Object.fromEntries(weights);
}

/**
 * Write each open quest's weight into `dir`'s weights file, replacing
 * it whole, unless it already says the same. Whether it was written.
 */
export function writeQuestWeights(questsRoot: string, dir: string): boolean {
	if (!existsSync(questsRoot)) return false;
	const file = join(dir, QUEST_WEIGHTS_FILE);
	const content = `${JSON.stringify(questWeights(questsRoot), null, "\t")}\n`;
	try {
		if (readFileSync(file, "utf8") === content) return false;
	} catch {
		// Not written yet.
	}
	mkdirSync(dir, { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, content);
	renameSync(temporary, file);
	return true;
}

/**
 * Bring the machine's weights file up to date, where the machine keeps
 * a jobs folder. A file that can't be written leaves the quests as they
 * stand and their work at the default weight: no quest action waits on
 * it or fails for it.
 */
export function keepQuestWeights(
	questsRoot: string,
	dir: string | undefined = process.platform === "linux"
		? machineQueueDir()
		: undefined,
): void {
	if (!dir) return;
	try {
		writeQuestWeights(questsRoot, dir);
	} catch {
		// The next quest action tries again.
	}
}

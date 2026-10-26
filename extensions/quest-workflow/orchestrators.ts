/**
 * The list of orchestrators, kept on disk for the desktop.
 *
 * The launcher's Agents place shows every orchestrator, live or not,
 * so it can offer to open one that has no session. It reads them from
 * `orchestrators.json` in quest-workflow's state folder rather than
 * walking every quest README itself. The file is looked at again after
 * every quest action (a mark, a conclusion, a retitle, a reparent) and
 * at each session start, so a mark made by hand still reaches it, and
 * it is written only when the list changed.
 */

import { join } from "node:path";
import { stateDir } from "../../lib/internal/paths.ts";
import {
	discoverQuests,
	type QuestIndex,
} from "../../lib/internal/quest/discovery.ts";
import { orchestrates } from "../../lib/internal/quest/orchestration.ts";
import { questAddress } from "../../lib/mesh/address.ts";
import { writeWhenChanged } from "./desktop-file.ts";

/** One orchestrator, as the desktop lists it. */
export interface OrchestratorEntry {
	/** The orchestrating quest's id. */
	readonly quest: string;
	/** The mesh address its session signs with. */
	readonly address: string;
	/** The quest's short name, when it has one. */
	readonly short?: string;
	/** The quest's title. */
	readonly title: string;
	/** The quest above it, when there is one. */
	readonly parent?: string;
}

/**
 * Bring the list up to date with the quests as they stand. A list that
 * can't be written leaves the last one standing: no quest action waits
 * on it or fails for it.
 */
export function keepOrchestratorsListed(questsRoot: string): void {
	try {
		writeOrchestrators(orchestratorsIn(discoverQuests(questsRoot).index));
	} catch {
		// The next quest action tries again.
	}
}

/** Where the list is kept. */
export function orchestratorsPath(): string {
	return join(stateDir("quest-workflow"), "orchestrators.json");
}

/**
 * Every quest that orchestrates and is still open, in tree order:
 * parents before children, siblings by rank. A concluded or retired
 * quest keeps its mark but orchestrates nothing, so it is left out.
 */
export function orchestratorsIn(index: QuestIndex): OrchestratorEntry[] {
	const found: OrchestratorEntry[] = [];
	const seen = new Set<string>();
	const visit = (parent: string) => {
		const ids = [...(index.children.get(parent) ?? [])].sort(byRank(index));
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			const entry = index.quests.get(id);
			if (!entry) continue;
			const fm = entry.doc.frontMatter;
			if (orchestrates(fm) && isOpen(fm.status)) {
				found.push({
					quest: id,
					address: questAddress(id),
					...(fm.short ? { short: fm.short } : {}),
					title: entry.doc.title ?? id,
					...(fm.parent ? { parent: fm.parent } : {}),
				});
			}
			visit(id);
		}
	};
	visit("");
	return found;
}

/**
 * Write the list when it differs from what is there, by a rename so a
 * reader never sees half a file. Answers whether it wrote.
 */
export function writeOrchestrators(
	list: readonly OrchestratorEntry[],
	path: string = orchestratorsPath(),
): boolean {
	return writeWhenChanged(path, { orchestrators: list });
}

/** Whether a quest is still open: neither concluded nor retired. */
export function isOpen(status: string): boolean {
	return status !== "concluded" && status !== "retired";
}

/** Siblings in their order: by rank, then by id. */
export function byRank(index: QuestIndex): (a: string, b: string) => number {
	const rank = (id: string) =>
		index.quests.get(id)?.doc.frontMatter.rank ?? Number.MAX_SAFE_INTEGER;
	return (a, b) => rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * The spend tool's disk report: what each quest holds on disk beside
 * what it spent, and how much of it could go now.
 *
 * Money is one cost of a quest; the disk it fills is another, and the
 * one that stops every quest at once when it runs out. The measuring
 * and the rules for what is reclaimable are in
 * `lib/internal/quest/footprint.ts`; this reads the quests and says it.
 */

import { discoverQuests } from "../../lib/internal/quest/discovery.ts";
import {
	formatSize,
	type Holdings,
	leftBehindOf,
	MEASURE_DEADLINE_MS,
	type Measure,
	measureHoldings,
	ownOf,
	type QuestHolding,
	type QuestOnDisk,
	reclaimableOf,
	sum,
} from "../../lib/internal/quest/footprint.ts";

/** Every quest under `questsRoot`, as its footprint needs it. */
export function questsOnDisk(questsRoot: string): QuestOnDisk[] {
	const { index } = discoverQuests(questsRoot);
	return [...index.quests.values()].map((entry) => {
		const fm = entry.doc.frontMatter;
		return {
			id: fm.id,
			...(entry.doc.title !== undefined ? { title: entry.doc.title } : {}),
			status: fm.status,
			trees: fm.trees ?? [],
		};
	});
}

/** What every quest under `questsRoot` holds, measured with `measure`. */
export function measureQuests(
	questsRoot: string,
	workspaceRoot: string,
	measure: Measure,
): Promise<Holdings> {
	return measureHoldings(questsOnDisk(questsRoot), workspaceRoot, measure);
}

function holdingLine(holding: QuestHolding): string {
	const own = ownOf(holding);
	const parts: string[] = [];
	if (holding.workspace) {
		parts.push(`scratch folder ${formatSize(holding.workspace)}`);
	}
	const made = holding.finished ? "a tree it left behind" : "a tree it made";
	for (const tree of holding.made) {
		parts.push(`${made}, ${formatSize(tree.size)}, at ${tree.path}`);
	}
	const adopted = holding.adopted.length;
	if (adopted > 0) {
		parts.push(
			`works in ${adopted} adopted ${adopted === 1 ? "tree" : "trees"}`,
		);
	}
	const free = reclaimableOf(holding);
	const verdict = !holding.finished
		? "still in use"
		: holding.made.length > 0
			? `${formatSize(free)} could go, and a release decides the rest`
			: "all of it could go";
	const title = holding.title ? ` ${holding.title}` : "";
	return `- ${holding.id}${title} [${holding.status}]: ${formatSize(own)}, ${verdict} (${parts.join("; ")})`;
}

/** The report, heaviest quest first, showing at most `limit` of them. */
export function formatHoldings(holdings: Holdings, limit: number): string {
	const quests = [...holdings.quests].sort(
		(a, b) => ownOf(b).bytes - ownOf(a).bytes,
	);
	const own = sum(quests.map(ownOf));
	const free = sum(quests.map(reclaimableOf));
	const left = sum(quests.map(leftBehindOf));
	const adopted = sum(holdings.adopted.map((a) => a.size));
	const lines = [
		`Quests hold ${formatSize(own)} of their own on disk, and ${formatSize(free)} of it could go now: the scratch folders of finished quests.`,
	];
	if (left.bytes > 0 || !left.complete) {
		lines.push(
			`Finished quests also left ${formatSize(left)} in trees whose release was refused when they ended. Load the quest and run quest tree-release to take each, once its work is merged or saved.`,
		);
	}
	if (holdings.adopted.length > 0) {
		lines.push(
			`The ${holdings.adopted.length} trees quests adopted hold ${formatSize(adopted)} more, counted once each. Those are your own checkouts, never any quest's to free; work tidy says when one is spent.`,
		);
	}
	if (quests.length > 0) {
		lines.push("", "Heaviest first:");
		lines.push(...quests.slice(0, limit).map(holdingLine));
		if (quests.length > limit) {
			lines.push(`And ${quests.length - limit} more; ask for a larger limit.`);
		}
	}
	const cut = [own, free, left, adopted].some((s) => !s.complete);
	if (cut) {
		lines.push(
			"",
			`Figures marked "at least" are lower bounds: measuring stops after ${MEASURE_DEADLINE_MS / 1000} s, so this never holds a session up for long.`,
		);
	}
	return lines.join("\n");
}

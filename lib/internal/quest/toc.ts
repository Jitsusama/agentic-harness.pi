/**
 * Table-of-contents renderer: produce the at-a-glance index
 * of the whole tree on demand. This builds the markdown; it
 * does not write a file. Nothing auto-generates a QUESTS.md,
 * so a consumer that wants one calls this and writes the
 * result itself.
 *
 * Shape:
 *
 *     # Quests
 *
 *     ## 🚀 Driving
 *
 *     - ◆ QEST-... Title One [status]
 *     - ◇ QEST-... Title Two [status]
 *
 *     ## ⚡ Active
 *
 *     ...
 *
 * Quests are grouped by priority (Driving, Active, Queued,
 * Bench, Someday) and within each group sorted by rank.
 * Concluded and retired quests collapse into a single
 * trailing section so they don't crowd the live work.
 */

import type {
	QuestKind,
	QuestPriority,
	QuestStatus,
} from "../../quest/types.js";
import type { QuestEntry, QuestIndex } from "./discovery.js";

const PRIORITY_LABELS: Array<{ priority: QuestPriority; label: string }> = [
	{ priority: "driving", label: "🚀 Driving" },
	{ priority: "active", label: "⚡ Active" },
	{ priority: "queued", label: "📋 Queued" },
	{ priority: "bench", label: "🪑 Bench" },
	{ priority: "someday", label: "🌌 Someday" },
];

const KIND_GLYPHS: Record<QuestKind, string> = {
	quest: "◆",
	subquest: "◈",
	sidequest: "◇",
};

const PROGRESS_BAR: Record<QuestStatus, string> = {
	active: "○",
	paused: "◔",
	blocked: "◑",
	concluded: "●",
	retired: "◕",
};

function questLine(entry: QuestEntry): string {
	const fm = entry.doc.frontMatter;
	const kindGlyph = KIND_GLYPHS[fm.kind] ?? "·";
	const statusGlyph = PROGRESS_BAR[fm.status] ?? "·";
	const title = entry.doc.title ?? "(untitled)";
	return `- ${kindGlyph} ${statusGlyph} \`${fm.id}\` ${title}`;
}

function sortEntries(entries: QuestEntry[]): QuestEntry[] {
	return [...entries].sort((a, b) => {
		const rankCmp = a.doc.frontMatter.rank - b.doc.frontMatter.rank;
		if (rankCmp !== 0) return rankCmp;
		return a.doc.frontMatter.id.localeCompare(b.doc.frontMatter.id);
	});
}

/** Render the TOC as a markdown string. */
export function renderToc(index: QuestIndex): string {
	const live: QuestEntry[] = [];
	const concluded: QuestEntry[] = [];
	for (const entry of index.quests.values()) {
		const status = entry.doc.frontMatter.status;
		if (status === "concluded" || status === "retired") {
			concluded.push(entry);
		} else {
			live.push(entry);
		}
	}

	const sections: string[] = ["# Quests", ""];
	for (const { priority, label } of PRIORITY_LABELS) {
		const group = sortEntries(
			live.filter((e) => e.doc.frontMatter.priority === priority),
		);
		if (group.length === 0) continue;
		sections.push(`## ${label}`, "");
		for (const entry of group) sections.push(questLine(entry));
		sections.push("");
	}

	if (concluded.length > 0) {
		sections.push("## 🗄️ Concluded and Retired", "");
		for (const entry of sortEntries(concluded)) sections.push(questLine(entry));
		sections.push("");
	}

	return `${sections.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * One-shot backfill: derive the `sessions` frontmatter for existing
 * quests from the pi session store.
 *
 * The migrated quests carry empty `sessions` lists because capture
 * only became automatic recently. This pass scans every session log
 * for the quest-workflow markers it persists (the loaded quest id
 * plus the session cwd) and writes those sessions back onto each
 * quest, so the reverse-scan of the session store is no longer
 * needed and the 257 imported quests become honest about where
 * their work happened. It is idempotent and dry-run-able.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, sessionsDir } from "../lib/internal/paths.js";
import { discoverQuests } from "../lib/internal/quest/discovery.js";
import { atomicWriteFile } from "../lib/internal/quest/io.js";
import {
	parseQuestFrontMatter,
	type QuestFrontMatter,
	type QuestSession,
	serializeQuestFrontMatter,
} from "../lib/quest/index.js";

/** One session's contribution to a quest, derived from its log. */
export interface SessionRecord {
	sessionId: string;
	questId: string;
	cwd?: string;
	started?: string;
	name?: string;
}

/** Scan the pi session store for sessions that loaded a quest. */
export function scanSessionStore(sessionDir: string): SessionRecord[] {
	const records: SessionRecord[] = [];
	for (const file of sessionFiles(sessionDir)) {
		const record = scanOne(file);
		if (record) records.push(record);
	}
	return records;
}

/** Enumerate every JSONL session log under the store. */
function sessionFiles(sessionDir: string): string[] {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(sessionDir, { withFileTypes: true });
	} catch {
		// Store missing or unreadable; nothing to backfill.
		return files;
	}
	for (const entry of entries) {
		const full = join(sessionDir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(full);
		} else if (entry.isDirectory()) {
			try {
				for (const inner of readdirSync(full)) {
					if (inner.endsWith(".jsonl")) files.push(join(full, inner));
				}
			} catch {
				// Unreadable subdir; skip it.
			}
		}
	}
	return files;
}

/** Derive one session's quest contribution, or undefined. */
function scanOne(path: string): SessionRecord | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	let sessionId: string | undefined;
	let headerCwd: string | undefined;
	let questId: string | undefined;
	let entryCwd: string | undefined;
	let name: string | undefined;
	let newest: string | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let entry: Record<string, unknown>;
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed !== "object" || parsed === null) continue;
			entry = parsed as Record<string, unknown>;
		} catch {
			continue;
		}
		const ts = entry.timestamp;
		if (typeof ts === "string") newest = ts;
		else if (typeof ts === "number") newest = new Date(ts).toISOString();
		if (entry.type === "session") {
			if (typeof entry.id === "string") sessionId = entry.id;
			if (typeof entry.cwd === "string") headerCwd = entry.cwd;
		} else if (entry.type === "session_info") {
			if (typeof entry.name === "string") name = entry.name;
		} else if (
			entry.type === "custom" &&
			entry.customType === "quest-workflow" &&
			typeof entry.data === "object" &&
			entry.data !== null
		) {
			const data = entry.data as Record<string, unknown>;
			if (typeof data.questId === "string") questId = data.questId;
			if (typeof data.cwd === "string") entryCwd = data.cwd;
		}
	}
	if (!sessionId || !questId) return undefined;
	const record: SessionRecord = { sessionId, questId };
	const cwd = entryCwd ?? headerCwd;
	if (cwd) record.cwd = cwd;
	if (newest) record.started = newest;
	if (name) record.name = name;
	return record;
}

/** Derived sessions that are not already on the quest. */
export function sessionsToAdd(
	existing: QuestSession[],
	derived: QuestSession[],
): QuestSession[] {
	const have = new Set(existing.map((s) => s.id));
	return derived.filter((s) => !have.has(s.id));
}

/** One quest's planned session additions. */
export interface BackfillEntry {
	questDir: string;
	questId: string;
	add: QuestSession[];
}

/** The full backfill plan across the quests root. */
export interface BackfillPlan {
	entries: BackfillEntry[];
}

/** Turn a scanned record into a historical (detached) session. */
function recordToSession(record: SessionRecord): QuestSession {
	const session: QuestSession = { id: record.sessionId, status: "detached" };
	if (record.cwd) session.cwd = record.cwd;
	if (record.started) session.started = record.started;
	if (record.name) session.name = record.name;
	return session;
}

/**
 * Plan the backfill: for every quest that the session store
 * references, the sessions it is missing. Idempotent -- a quest
 * whose sessions are all already recorded produces no entry.
 */
export function planBackfill(
	questsRoot: string,
	sessionDir: string,
): BackfillPlan {
	const byQuest = new Map<string, QuestSession[]>();
	for (const record of scanSessionStore(sessionDir)) {
		const list = byQuest.get(record.questId) ?? [];
		if (!list.some((s) => s.id === record.sessionId)) {
			list.push(recordToSession(record));
		}
		byQuest.set(record.questId, list);
	}

	const { index } = discoverQuests(questsRoot);
	const entries: BackfillEntry[] = [];
	for (const [questId, derived] of byQuest) {
		const quest = index.quests.get(questId);
		if (!quest) continue;
		const add = sessionsToAdd(quest.doc.frontMatter.sessions, derived);
		if (add.length > 0) entries.push({ questDir: quest.dir, questId, add });
	}
	entries.sort((a, b) => a.questId.localeCompare(b.questId));
	return { entries };
}

/** Apply a backfill plan: append the missing sessions to each quest. */
export function applyBackfill(plan: BackfillPlan): void {
	for (const entry of plan.entries) {
		const path = join(entry.questDir, "README.md");
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const parsed = parseQuestFrontMatter(text);
		if (!parsed) continue;
		const fm: QuestFrontMatter = {
			...parsed.frontMatter,
			sessions: [...parsed.frontMatter.sessions, ...entry.add],
		};
		atomicWriteFile(path, `${serializeQuestFrontMatter(fm)}\n${parsed.body}`);
	}
}

function summarize(plan: BackfillPlan): string {
	if (plan.entries.length === 0) return "No quests need backfilling.";
	const lines = [`Backfilling ${plan.entries.length} quest(s):`];
	for (const entry of plan.entries) {
		lines.push(`  ${entry.questId}: +${entry.add.length} session(s)`);
	}
	return lines.join("\n");
}

function main(): void {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const rootIndex = args.indexOf("--root");
	const root =
		rootIndex >= 0
			? (args[rootIndex + 1] ?? "")
			: join(dataDir("quest-workflow"), "quests");
	const storeIndex = args.indexOf("--session-dir");
	const store = storeIndex >= 0 ? (args[storeIndex + 1] ?? "") : sessionsDir();

	const plan = planBackfill(root, store);
	console.log(summarize(plan));
	if (dryRun) {
		console.log("\n(dry run: no changes applied)");
		return;
	}
	applyBackfill(plan);
	if (plan.entries.length > 0) console.log("\nBackfill applied.");
}

// Only run when invoked directly so tests can import the
// planning helpers without touching the live quest tree.
if (require.main === module) {
	main();
}

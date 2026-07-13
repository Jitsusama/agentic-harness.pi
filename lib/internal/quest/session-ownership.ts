/**
 * Ownership resolution from a session's own log.
 *
 * A quest's `sessions:` frontmatter is a denormalized index; the
 * authoritative current quest of a session is whatever quest-workflow
 * entry its pi log recorded last. Reconciliation and repair read this
 * so they can resolve a session claimed by several quests from the
 * session's recorded intent rather than from a liveness probe.
 */

import { readFileSync } from "node:fs";

/**
 * The quest a session is authoritatively on, from the last
 * quest-workflow entry in its log. Undefined when the log has no such
 * entry, the last one cleared the quest, or the log cannot be read.
 * Reads the whole log because the deciding entry can sit anywhere;
 * this is a reconcile/repair path, not a hot render path.
 */
export function authoritativeQuestFromLog(logPath: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(logPath, "utf8");
	} catch {
		// Log missing or unreadable: no authoritative answer.
		return undefined;
	}
	let current: string | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			// A partially written line; skip it and keep scanning.
			continue;
		}
		const questId = questIdOfEntry(entry);
		if (questId !== false) current = questId;
	}
	return current;
}

/**
 * The questId a quest-workflow log entry records, `undefined` when it
 * cleared the quest, or `false` when the entry is not a quest-workflow
 * entry at all (so the scan leaves the running value untouched).
 */
function questIdOfEntry(entry: unknown): string | undefined | false {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	if (e.type !== "custom" || e.customType !== "quest-workflow") return false;
	const data = e.data;
	if (typeof data !== "object" || data === null) return undefined;
	const questId = (data as Record<string, unknown>).questId;
	return typeof questId === "string" && questId.length > 0
		? questId
		: undefined;
}

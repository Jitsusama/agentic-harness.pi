/**
 * Ownership resolution from a session's own log.
 *
 * A quest's `sessions:` frontmatter is a denormalized index; the
 * authoritative current quest of a session is whatever quest-workflow
 * entry its pi log recorded last. Reconciliation and repair read this
 * so they can resolve a session claimed by several quests from the
 * session's recorded intent rather than from a liveness probe.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * How much of a log's end to read. Comfortably more than the last
 * entries of any ordinary session, and small enough that reading it
 * costs nothing next to the gigabyte the whole-file read could.
 */
const LOG_TAIL_BYTES = 1024 * 1024;

/**
 * The last {@link LOG_TAIL_BYTES} of a file, decoded as text.
 *
 * The first line is dropped when the file is longer than the window,
 * since the window almost certainly lands mid-line and a half-entry
 * would only fail to parse. Nothing else compensates for the cut: a
 * caller that needs the whole log should not be using this.
 */
function readLogTail(path: string): string {
	const fd = openSync(path, "r");
	try {
		const { size } = fstatSync(fd);
		const length = Math.min(size, LOG_TAIL_BYTES);
		const buffer = Buffer.allocUnsafe(length);
		readSync(fd, buffer, 0, length, size - length);
		const text = buffer.toString("utf8");
		if (size <= LOG_TAIL_BYTES) return text;
		const firstBreak = text.indexOf("\n");
		return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
	} finally {
		closeSync(fd);
	}
}

/**
 * The quest a session is authoritatively on, from the last
 * quest-workflow entry in its log. Undefined when the log has no such
 * entry, the last one cleared the quest, or the log cannot be read.
 * Reads a bounded tail rather than the whole file. A real session log
 * reached 1.2 GB, and V8 caps a string near 512 MB, so reading it
 * whole allocated a gigabyte and then threw, leaving that session
 * permanently unresolvable. The deciding entry is the last one, so
 * the end of the log is where the answer lives; a quest named only
 * further back than the window reads as no answer, which is what an
 * unreadable log already returned.
 */
export function authoritativeQuestFromLog(logPath: string): string | undefined {
	let text: string;
	try {
		text = readLogTail(logPath);
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

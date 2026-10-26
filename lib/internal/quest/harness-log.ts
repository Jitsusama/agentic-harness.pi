/**
 * A quest's harness log: the bookkeeping the harness does on a quest's
 * behalf (a tree adopted, added or pruned, an alias linked, the
 * workspace's tmp/ cleared), kept in `harness.log` beside the README
 * rather than in the Journey.
 *
 * The Journey is what a session reads to learn how a quest got where
 * it is, so it keeps what people and sessions did. Bookkeeping was a
 * quarter of all Journey entries, "Adopted tree" alone 184 in two
 * days, and every reader paid for it.
 *
 * One line per entry, oldest first, each opening with its UTC time to
 * the second, so a new line is appended and a reader wanting the
 * latest reads the end. The log keeps the newest `HARNESS_LOG_LINES`,
 * trimmed as it is written, under the quest's lock. It is record, so
 * the backup carries it, but it cites nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_LOG_FILE_NAME } from "../../core/internal/quest/record.ts";
import { atomicWriteFile, withQuestLock } from "./io.ts";

/** How many lines a harness log keeps, newest last. */
export const HARNESS_LOG_LINES = 2000;

/** Where a quest's harness log lives. */
export function harnessLogPath(questDir: string): string {
	return join(questDir, HARNESS_LOG_FILE_NAME);
}

/**
 * Append one line to a quest's harness log, trimming it to the newest
 * `HARNESS_LOG_LINES`. Returns `false` when the quest has no README,
 * as the Journey's writer does, so a caller can tell nothing was kept.
 */
export function appendHarnessLog(
	questDir: string,
	text: string,
	opts?: { now?: () => Date },
): boolean {
	if (!existsSync(join(questDir, "README.md"))) return false;
	const stamp = (opts?.now?.() ?? new Date())
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z");
	const line = `${stamp} ${text.trim().replace(/\s*\n\s*/g, " ")}`;
	withQuestLock(questDir, () => {
		const path = harnessLogPath(questDir);
		const lines = existsSync(path)
			? readFileSync(path, "utf8").split("\n").filter(Boolean)
			: [];
		lines.push(line);
		atomicWriteFile(path, `${lines.slice(-HARNESS_LOG_LINES).join("\n")}\n`);
	});
	return true;
}

/**
 * Append a Journey bullet to a quest README at a known
 * path. Pure file operation, no extension state involved.
 * The extension's `appendJourneyEntry` wraps this for the
 * loaded-quest case; downstream callers (the PR-sidequest
 * bridge in particular) use this directly so they can write
 * to any quest the alias index points them at.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nowYmd } from "./dates.js";
import { atomicWriteFile, withQuestLock } from "./io.js";

/**
 * Append a Journey bullet to `<questDir>/README.md`. When
 * the Journey section is missing, append the whole section
 * with the bullet inside. `now` is injected so tests can
 * pin the date stamp.
 *
 * Returns `true` on success, `false` when the README is
 * missing or unreadable so callers can log instead of
 * silently dropping the journal entry.
 */
export function appendJourneyByPath(
	questDir: string,
	prose: string,
	opts?: { now?: () => Date },
): boolean {
	const path = join(questDir, "README.md");
	return withQuestLock(questDir, () => {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return false;
		}
		const date = nowYmd(opts?.now);
		const bullet = `- **${date}**: ${prose.trim()}`;
		const journeyHeading = /^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Journey\s*$/mu;
		const match = journeyHeading.exec(text);
		let newText: string;
		if (match) {
			const lines = text.split("\n");
			let lineIdx = 0;
			let charCount = 0;
			for (let i = 0; i < lines.length; i++) {
				if (charCount + lines[i].length + 1 > match.index) {
					lineIdx = i;
					break;
				}
				charCount += lines[i].length + 1;
			}
			let insertAt = lineIdx + 1;
			while (insertAt < lines.length && lines[insertAt].trim() === "") {
				insertAt++;
			}
			lines.splice(insertAt, 0, bullet);
			newText = lines.join("\n");
		} else {
			newText = `${text.replace(/\n*$/, "\n")}\n## 🌄 Journey\n\n${bullet}\n`;
		}
		atomicWriteFile(path, newText);
		return true;
	});
}

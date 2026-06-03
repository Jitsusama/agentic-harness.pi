/**
 * Append a Journey bullet to a quest README at a known
 * path. Pure file operation, no extension state involved.
 * The extension's `appendJourneyEntry` wraps this for the
 * loaded-quest case; downstream callers (the PR-sidequest
 * bridge in particular) use this directly so they can write
 * to any quest the alias index points them at.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function nowYmd(now: () => Date): string {
	const d = now();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Append a Journey bullet to `<questDir>/README.md`. When
 * the Journey section is missing, append the whole section
 * with the bullet inside. `now` is injected so tests can
 * pin the date stamp.
 */
export function appendJourneyByPath(
	questDir: string,
	prose: string,
	opts?: { now?: () => Date },
): void {
	const path = join(questDir, "README.md");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return;
	}
	const date = nowYmd(opts?.now ?? (() => new Date()));
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
	writeFileSync(path, newText, "utf8");
}

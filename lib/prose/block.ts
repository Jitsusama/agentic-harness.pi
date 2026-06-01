/**
 * Turns detected prose violations into a single skill-grounded
 * instruction the guardian hands back to the author. The message
 * names every violation and points at the prose-standard skill so
 * the retry is informed, not a guess.
 */

import type { ProseViolation } from "./detect.js";

/** Format prose violations into a block message, or "" if none. */
export function formatProseBlock(violations: ProseViolation[]): string {
	if (violations.length === 0) return "";

	const lines: string[] = [
		"This text does not follow the prose-standard skill. Fix the",
		"violations below and try again, applying the skill's nuance",
		"rather than a mechanical substitution.",
		"",
	];

	const emdashes = violations.filter((v) => v.kind === "emdash");
	if (emdashes.length > 0) {
		const count = emdashes.length;
		lines.push(
			`- ${count} emdash${count === 1 ? "" : "es"}: never use emdashes.`,
			"  Restructure the sentence (a colon, a semi-colon, parentheses",
			"  or a new sentence), per prose-standard.",
		);
	}

	// Deduplicate spellings by their found -> suggestion pairing so a
	// word that recurs is named once.
	const spellings = new Map<string, string>();
	for (const v of violations) {
		if (v.kind !== "spelling" || !v.suggestion) continue;
		spellings.set(v.found.toLowerCase(), `${v.found} -> ${v.suggestion}`);
	}
	if (spellings.size > 0) {
		lines.push(
			`- Non-Canadian spelling: ${[...spellings.values()].join(", ")}.`,
			"  Use Canadian English spelling exclusively, per prose-standard.",
		);
	}

	return lines.join("\n");
}

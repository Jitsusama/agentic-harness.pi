/**
 * Turns detected section violations into a single skill-grounded
 * instruction the guardian hands back to the author. The message
 * names every invented and missing heading and points at the
 * format skill so the retry is informed, not a guess.
 */

import type { SectionViolation } from "./detect.js";

/** Format section violations into a block message, or "" if none. */
export function formatSectionBlock(
	violations: SectionViolation[],
	entityLabel: string,
	skill: string,
): string {
	if (violations.length === 0) return "";

	const invented = violations.filter((v) => v.issue === "invented");
	const missing = violations.filter((v) => v.issue === "missing");

	const lines: string[] = [
		`This ${entityLabel} body does not use the sections the`,
		`${skill} skill defines. The section set is closed: use exactly`,
		"those headings, written exactly as the skill shows them (the",
		"emoji, the name and the heading level together). Fix the body",
		"and try again.",
		"",
	];

	if (invented.length > 0) {
		lines.push("Headings that are not part of the set, remove or rename them:");
		for (const v of invented) lines.push(`  ${v.found}`);
		lines.push("");
	}

	if (missing.length > 0) {
		lines.push("Required headings the body is missing, add them:");
		for (const v of missing) lines.push(`  ${v.found}`);
		lines.push("");
	}

	lines.push(`See the ${skill} skill for what belongs in each section.`);

	return lines.join("\n");
}

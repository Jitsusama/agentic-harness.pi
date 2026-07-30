/**
 * The authoring conventions, checked where authoring actually happens.
 *
 * A guardian intercepts shell commands, so `gh pr create` is held to
 * the PR format, the title convention and the prose standard. Proposing
 * a change through `review_offer` never touches a shell: it builds a
 * JSON body and posts it to an API. Left alone, that is a way to route
 * around every convention this package enforces, and the better the
 * tool got the more attractive that route became.
 *
 * So the same three checks run here, over the same detectors, before
 * anything is sent. This is not the guardian's code copied: the
 * detectors are pure and shared, and only the response differs. A
 * guardian blocks a command and relents to a human on a repeat, because
 * it cannot rewrite the words. A tool can simply be called again with a
 * better body, so a refusal here is a plain refusal with no relent
 * path, which is also why it cannot loop.
 */

import { detectProseViolations } from "../../lib/prose/index.js";
import {
	detectSectionViolations,
	PR_SECTIONS,
} from "../../lib/sections/index.js";
import { detectTitleViolations } from "../../lib/title/index.js";

/**
 * What was wrong, said once per habit rather than once per instance.
 *
 * A prose violation names its own rule in a sentence; a section or
 * title violation carries an issue and the offending text, which read
 * better together. So callers pass descriptions rather than a field,
 * because there is no one field that suits all three.
 */
function tally(descriptions: string[]): string[] {
	const counts = new Map<string, number>();
	for (const one of descriptions) counts.set(one, (counts.get(one) ?? 0) + 1);
	return [...counts].map(
		([one, count]) => `   ${one}${count > 1 ? ` (${count} times)` : ""}`,
	);
}

/**
 * A refusal naming what to fix about a proposal, or nothing.
 *
 * The order matters and is the guardian's: structure, then title, then
 * prose. There is no point polishing the words in a section that should
 * not exist, and a wrong title should be caught alongside the structure
 * rather than after the writing has been redone.
 */
export function proposalComplaint(
	title: string | undefined,
	body: string | undefined,
): string | undefined {
	if (body !== undefined && body.trim() !== "") {
		const sections = detectSectionViolations(body, PR_SECTIONS);
		if (sections.length > 0) {
			return [
				"This body does not match the PR format, and proposing is not a way around it.",
				...tally(sections.map((one) => `${one.issue}: ${one.found}`)),
				"Read the github-pr-format skill: the section set is closed.",
			].join("\n");
		}
	}

	if (title !== undefined && title.trim() !== "") {
		const titles = detectTitleViolations(title);
		if (titles.length > 0) {
			return [
				"This title does not match the convention.",
				...tally(titles.map((one) => `${one.issue}: ${one.found}`)),
				"Read the github-pr-format skill for the title rules.",
			].join("\n");
		}
	}

	if (body !== undefined && body.trim() !== "") {
		const prose = detectProseViolations(body);
		if (prose.length > 0) {
			return [
				"This body breaks the prose standard.",
				...tally(prose.map((one) => one.rule)),
				"Rewrite it and propose again.",
			].join("\n");
		}
	}

	return undefined;
}

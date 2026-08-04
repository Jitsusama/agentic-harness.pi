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
 *
 * The same formatters too. This used to tally an issue word against the
 * offending text, which said "use Canadian English spelling" without
 * naming the word, and printed the title rule's internal word list as
 * though it were a diagnosis: `sentence-case: fix(review, replay,
 * whole, resolution`. The guardian's blocks already name the word and
 * its replacement, and explain what Title Case wants, so both paths now
 * say the same thing and there is one place to improve it.
 */

import {
	detectProseViolations,
	formatProseBlock,
} from "../../lib/prose/index.js";
import {
	detectSectionViolations,
	formatSectionBlock,
	PR_SECTIONS,
} from "../../lib/sections/index.js";
import {
	detectTitleViolations,
	formatTitleBlock,
} from "../../lib/title/index.js";

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
	const written = body !== undefined && body.trim() !== "";
	const named = title !== undefined && title.trim() !== "";

	// Every class at once, in the guardian's order. Returning at the first
	// one made each fix reveal the next: a body was refused for its
	// sections, then for its title, then for an emdash, and every round
	// trip through the tool was another chance for something else to go
	// wrong. One refusal that says everything costs one rewrite.
	const blocks = [
		written
			? formatSectionBlock(
					detectSectionViolations(body, PR_SECTIONS),
					"pull request",
					"github-pr-format",
				)
			: "",
		named
			? formatTitleBlock(
					detectTitleViolations(title),
					"pull request",
					"github-pr-format",
				)
			: "",
		written ? formatProseBlock(detectProseViolations(body)) : "",
	].filter((block) => block !== "");

	if (blocks.length === 0) return undefined;
	return blocks.join("\n").trimEnd();
}

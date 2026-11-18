/**
 * Sending a shell `gh pr` that puts a change in front of people to
 * review_offer, which holds it until our own council has read it.
 *
 * Joel, 17 November: "we must run our own reviews on everything before
 * asking for reviews from others". review_offer keeps that at every
 * door it has (extensions/review-integration/reviewed-first.ts), and
 * the shell had the same doors open beside it: `gh pr create` without
 * `--draft`, `gh pr create --reviewer`, `gh pr ready` and
 * `gh pr edit --add-reviewer`. Those are refused here, naming the
 * review_offer action that does the same thing once a council has
 * read the change. A draft with no reviewers, `gh pr ready --undo` and
 * every other `gh pr` go through, since nobody is asked to look.
 *
 * It refuses rather than reading the councils itself, because
 * review_offer is already the one door that knows a change's own
 * commits, and a second reading of them here could only disagree with
 * it. Not held: `gh api` calls that request reviewers, which name an
 * endpoint rather than a move.
 */

import {
	type FlagSpec,
	findFlag,
	type SimpleCommand,
	tokenize,
} from "../../lib/command/index.ts";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import type {
	CommandGuardian,
	GuardianBlock,
} from "../../lib/guardian/types.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";

/** The `gh pr` flags that decide whether people are asked to look. */
const ASKING_FLAGS: FlagSpec = {
	flags: [
		{ name: "draft", long: "draft", short: "d", takesValue: false },
		{ name: "reviewer", long: "reviewer", short: "r", takesValue: true },
		{ name: "add-reviewer", long: "add-reviewer", takesValue: true },
		{ name: "undo", long: "undo", takesValue: false },
	],
};

/** A shell `gh pr` that asks people to look, and what to use instead. */
export interface PeopleAsked {
	/** The move, as the refusal says it, e.g. `gh pr ready`. */
	readonly move: string;
	/** The review_offer action that makes the same move. */
	readonly instead: string;
}

/** What a `gh pr` command asks of people, or null when it asks nothing. */
function asks(gh: SimpleCommand): PeopleAsked | null {
	const has = (name: string) => findFlag(gh, ASKING_FLAGS, name) !== undefined;
	switch (gh.argv[2]?.text) {
		case "create":
			if (has("reviewer"))
				return {
					move: "gh pr create --reviewer",
					instead: "review_offer propose, then review_offer reviewers",
				};
			if (!has("draft"))
				return {
					move: "gh pr create without --draft",
					instead: "review_offer propose with draft: false",
				};
			return null;
		case "ready":
			return has("undo")
				? null
				: { move: "gh pr ready", instead: "review_offer ready" };
		case "edit":
			return has("add-reviewer")
				? {
						move: "gh pr edit --add-reviewer",
						instead: "review_offer reviewers",
					}
				: null;
		default:
			return null;
	}
}

/** The first `gh pr` in a command line that asks people to look. */
export function peopleAsked(command: string): PeopleAsked | null {
	for (const gh of tokenize(command).commands) {
		if (gh.argv[0]?.text !== "gh" || gh.argv[1]?.text !== "pr") continue;
		const asked = asks(gh);
		if (asked) return asked;
	}
	return null;
}

/** The refusal, naming the review_offer action to use instead. */
function refusal(asked: PeopleAsked): GuardianBlock {
	return {
		block: true,
		reason:
			`${asked.move} puts the change in front of people, and the shell ` +
			"can't tell whether our own council has read it. Use " +
			`${asked.instead}: it goes ahead once a finished council of ours ` +
			"has read one of the change's own commits, and says what to run " +
			"when none has. A draft with no reviewers (gh pr create --draft) " +
			"still goes up from the shell.",
	};
}

/** Guardian refusing a shell `gh pr` that asks people before our council. */
export const councilFirstGuardian: CommandGuardian<PeopleAsked> = {
	detect: (command) => peopleAsked(command) !== null,
	parse: peopleAsked,
	review: async (asked) =>
		refusalUnder(
			GUARDS.councilFirst.name,
			refusal(asked),
			"gh pr before our council",
			asked.move,
		),
};

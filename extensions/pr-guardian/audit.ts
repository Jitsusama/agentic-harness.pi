/**
 * The audit after a PR description is published through `gh`.
 *
 * The section gate runs before the command, under guard policy. In
 * report or off mode it lets a description through without the model
 * ever hearing why, and on a repeat it relents by design. Either way a
 * description outside its shape reaches the host and stays there. This
 * reads the description that was just published and, when it breaks the
 * shape, says so to the model as a follow-up in the same run, with the
 * same refusal the gate would have given and the tool to fix it with.
 *
 * It never blocks: the command has already run. That is what makes it
 * safe in every guard mode, and why it holds whether or not a gate did.
 * It says each problem once per description, so a model that cannot
 * fix one is not told the same thing every turn.
 *
 * `review_offer` does not need this: it refuses a description outside
 * its shape before sending it, whatever the guard policy says.
 */

import {
	detectBodyViolations,
	formatBodyBlock,
	PR_SECTIONS,
	PR_SHAPE,
	violationSignature,
} from "@jitsusama/agentic-harness.core/sections";
import { isPrCommand, parsePrCommand } from "./parse.ts";

/** The custom message type the audit speaks with. */
export const PR_AUDIT_MESSAGE = "pr-audit";

/** What the audit has to say about one command, or nothing. */
export function auditPublished(
	command: string,
	alreadySaid: ReadonlySet<string>,
): { signature: string; message: string } | undefined {
	if (!isPrCommand(command)) return undefined;
	const parsed = parsePrCommand(command);
	if (!parsed?.body) return undefined;

	const violations = detectBodyViolations(parsed.body, {
		sanctioned: PR_SECTIONS,
		shape: PR_SHAPE,
	});
	if (violations.length === 0) return undefined;

	const signature = violationSignature(violations, parsed.body);
	if (alreadySaid.has(signature)) return undefined;

	const which = parsed.prNumber ? `#${parsed.prNumber}` : "the PR just opened";
	return {
		signature,
		message: [
			`The description of ${which} was published outside the github-pr-format shape, so a person reading it is getting less than the change deserves. Fix it now with review_offer edit, passing problem, solution, validation and tldr, which writes the headings for you.`,
			"",
			formatBodyBlock(violations, "PR", "github-pr-format"),
		].join("\n"),
	};
}

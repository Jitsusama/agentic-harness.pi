/**
 * A shell gh pr that asks people to look goes to review_offer, which
 * waits for our own council; one that asks nobody goes through.
 *
 * review_offer holds every door it has until a council of ours has read
 * the change, and the shell had the same doors beside it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	councilFirstGuardian,
	peopleAsked,
} from "../../../extensions/pr-guardian/council-first.ts";

const ctx = {} as ExtensionContext;

/** What the guardian answers for a command line, as pi would ask it. */
async function verdict(command: string) {
	if (!councilFirstGuardian.detect(command)) return undefined;
	const parsed = councilFirstGuardian.parse(command);
	if (!parsed) return undefined;
	return councilFirstGuardian.review(parsed, ctx, "block");
}

describe("a shell gh pr that asks people to look", () => {
	const asking: [string, string, string][] = [
		["gh pr create --title T --body B", "without --draft", "propose"],
		["gh pr create --fill", "without --draft", "propose"],
		["gh pr create --draft --reviewer evan --fill", "--reviewer", "reviewers"],
		["gh pr create -d -r evan --fill", "--reviewer", "reviewers"],
		["gh pr ready 1797", "gh pr ready", "review_offer ready"],
		["gh pr edit 1797 --add-reviewer evan", "--add-reviewer", "reviewers"],
		[
			"git push -u origin topic && gh pr create --fill",
			"without --draft",
			"propose",
		],
	];

	for (const [command, move, instead] of asking) {
		it(`is sent to review_offer: ${command}`, async () => {
			const result = await verdict(command);

			expect(result).toMatchObject({ block: true });
			const reason = result && "reason" in result ? result.reason : "";
			expect(reason).toContain(move);
			expect(reason).toContain(instead);
			expect(reason).toContain("our own council");
		});
	}
});

describe("a shell gh pr that asks nobody", () => {
	const quiet = [
		"gh pr create --draft --fill",
		"gh pr create -d --fill",
		"gh pr ready 1797 --undo",
		"gh pr edit 1797 --title 'A Better Title'",
		"gh pr view 1797",
		"gh pr list --author @me",
		"gh issue create --title T --body B",
		"echo gh pr ready",
	];

	for (const command of quiet) {
		it(`goes through: ${command}`, async () => {
			expect(peopleAsked(command)).toBeNull();
			expect(await verdict(command)).toBeUndefined();
		});
	}
});

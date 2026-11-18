/**
 * Every round refuses a prompt too large to send before anyone is asked.
 *
 * On 18 Nov 2026 every round whose prompt held 1.79 million characters or
 * more ended "Request timed out" with no answer, for each reviewer at
 * once, after each had waited out its clock. The refusal is tested where
 * it is composed (`tests/core/review/ask/prompt.test.ts`); what can't be
 * driven is whether each round asks it before it starts its reviewers, a
 * judge or an auditor, so this sweeps the rounds' source, finding every
 * round that asks anyone rather than listing the ones there are today.
 */

import { describe, expect, it } from "vitest";
import { askFunctions } from "./ask-source.ts";

/** Where a round puts its prompt to a council, judge, critique or audit. */
const ASKS =
	/await (?:runCouncil|runJudge|runCritique|runAudit|runStackCouncil|startCouncil)\(/;

/** Where a refusal of a prompt too large is asked, and acted on. */
const REFUSED =
	/tooLargeToAsk\([\s\S]*?\)[\s\S]{0,40}?if \(tooLarge !== undefined\) return/;

/** Where a council's round is made, which asks the refusal itself. */
const MADE = "await councilRound(";

const functions = askFunctions();

/** Each function that asks anyone, with where it first does. */
function asking(): { name: string; body: string; asks: number }[] {
	return [...functions].flatMap(([name, body]) => {
		const asks = body.search(ASKS);
		return asks === -1 ? [] : [{ name, body, asks }];
	});
}

describe("a round whose prompt is too large to send", () => {
	it("is refused before anyone is asked, in every round that asks", () => {
		const wrong = asking().flatMap(({ name, body, asks }) => {
			const refused = body.search(REFUSED);
			const made = body.indexOf(MADE);
			if (refused !== -1 && refused < asks) return [];
			if (made !== -1 && made < asks) return [];
			return [`${name} asks before it refuses a prompt too large`];
		});

		expect(wrong).toEqual([]);
	});

	it("is refused where a council's round is made", () => {
		const body = functions.get("councilRound") ?? "";

		expect(
			REFUSED.test(body),
			"councilRound doesn't refuse a prompt too large",
		).toBe(true);
	});

	it("finds the rounds there are, not none", () => {
		// The sweep above passes over nothing at all against a mis-read
		// source. Seven: a council, a background council, a retry, a
		// judge, a critique, an audit and a stack.
		expect(asking().map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"askCouncil",
				"startRound",
				"retryOne",
				"askJudge",
				"askCritique",
				"askAudit",
				"askStack",
			]),
		);
	});
});

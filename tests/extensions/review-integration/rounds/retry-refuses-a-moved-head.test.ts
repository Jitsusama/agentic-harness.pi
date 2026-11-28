/**
 * A retry into a round the change has moved past is refused before it
 * claims anybody, asks anybody or writes the ledger.
 *
 * On core.nix#7308 a retry read the change's new head and substituted
 * its answer into a round witnessed at the old one, so the round
 * claimed its reviewers read a commit they never saw. The rule is
 * tested where it is composed (`tests/core/review/ask/run.test.ts`);
 * what can't be driven without a host, a roster and a reviewer is
 * where the retry asks it, so this reads the retry's source.
 */

import { describe, expect, it } from "vitest";
import { askFunctions } from "./ask-source.ts";

/**
 * Where the retry asks whether the head moved against the round it
 * read, and refuses on the answer. Loose on names and layout, since
 * what this holds is the order, not the spelling.
 */
const REFUSED = /retryHeadMoved\(\s*held,[^)]*\)[\s\S]{0,80}?return refuse\(/;

const retry = askFunctions().get("retryOne") ?? "";

describe("a retry into a round the change has moved past", () => {
	it("asks whether the head moved against the round it read", () => {
		expect(REFUSED.test(retry), "retryOne doesn't refuse a moved head").toBe(
			true,
		);
	});

	it.each([
		["claims anybody", "claimIdentities("],
		["asks anybody", "await runCouncil("],
		["writes the ledger", "substituteInRound("],
		["tells it to change a setting", "retryCannotResettle("],
		["tells it to raise a clock", "retryWouldRepeat("],
	])("is refused before it %s", (_what, act) => {
		const refused = retry.search(REFUSED);
		const acts = retry.indexOf(act);

		expect(acts, `retryOne no longer calls ${act}`).toBeGreaterThan(-1);
		expect(refused).toBeGreaterThan(-1);
		expect(refused).toBeLessThan(acts);
	});
});

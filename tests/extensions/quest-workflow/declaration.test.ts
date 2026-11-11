import { describe, expect, it } from "vitest";
import { QUEST_PARAMETERS } from "../../../extensions/quest-workflow/index.ts";

/**
 * The most characters the quest tool's parameters may declare. Every
 * session sends them on every turn, about $4 a day for each thousand
 * characters on 11 November 2026, when they ran to 8,411, the largest
 * of the 31 tools a session declares. What a parameter says beyond what
 * the agent acts on belongs in the tool's answers, which say it only
 * when it applies. Lower this as the declaration shrinks.
 */
const MOST_DECLARED = 6_300;

describe("the quest tool's declaration", () => {
	it(`declares its parameters in at most ${MOST_DECLARED} characters`, () => {
		const declared = JSON.stringify(QUEST_PARAMETERS).length;

		expect(
			declared,
			`the parameters declare ${declared} characters`,
		).toBeLessThanOrEqual(MOST_DECLARED);
	});

	it("still tells the agent what a spawn and a forced release risk", () => {
		const said = (name: keyof typeof QUEST_PARAMETERS.properties) => {
			const property: object = QUEST_PARAMETERS.properties[name];
			return "description" in property ? String(property.description) : "";
		};

		expect(said("command")).toContain("past every guard");
		expect(said("force")).toContain("confirm with the person first");
		expect(said("dryRun")).toContain("doing nothing");
	});
});

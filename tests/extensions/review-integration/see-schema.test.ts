/**
 * review_see declares its choices as string enums, as review_offer does
 * (#1370): the same choices in a third of the characters every session
 * sends every turn.
 */

import { describe, expect, it } from "vitest";
import { registerSeeTool } from "../../../extensions/review-integration/tools/see-tool.ts";
import { fakePi } from "../../support/fake-pi.ts";

/** The declared schema of one review_see parameter. */
function declared(name: string): unknown {
	const pi = fakePi();
	registerSeeTool(pi);
	const tool = pi.recorded.tools.find((one) => one.name === "review_see");
	const properties: Record<string, unknown> =
		JSON.parse(JSON.stringify(tool?.parameters ?? {})).properties ?? {};
	return properties[name];
}

describe("review_see's schema", () => {
	it("offers its actions as one string enum", () => {
		expect(declared("action"), "the action's choices").toMatchObject({
			type: "string",
			enum: [
				"change",
				"diff",
				"checks",
				"stack",
				"changes",
				"threads",
				"reviews",
				"messages",
				"findings",
				"followup",
			],
		});
	});

	it("offers a change's states as one string enum", () => {
		expect(declared("state"), "the state's choices").toMatchObject({
			type: "string",
			enum: ["open", "merged", "closed"],
		});
	});
});

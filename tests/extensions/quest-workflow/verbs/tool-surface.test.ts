import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { registerQuestTool } from "../../../../extensions/quest-workflow/wiring/tool.ts";
import { fakePi } from "../../../support/fake-pi.ts";

/**
 * The quest tool as pi is handed it: its name, its guidelines, and how
 * its call and result are drawn, pinned so moving where the tool is
 * registered keeps each.
 */

interface Drawn {
	render(width: number): string[];
}

interface Drawing {
	renderCall(args: unknown, theme: unknown, context: unknown): Drawn;
	renderResult(
		result: unknown,
		options: { expanded?: boolean },
		theme: unknown,
		context: unknown,
	): Drawn;
}

/** Wraps each coloured span in its token's name, so a test sees which colour drew it. */
const theme = {
	fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
	bold: (text: string) => text,
};

function registered() {
	const pi = fakePi();
	registerQuestTool(pi, createQuestState({ questsRoot: "/nowhere" }));
	expect(pi.recorded.tools, "one tool registered").toHaveLength(1);
	const [tool] = pi.recorded.tools;
	if (tool === undefined) throw new Error("no tool registered");
	return tool;
}

function drawing(): Drawing {
	const tool: object = registered();
	if (!("renderCall" in tool) || !("renderResult" in tool)) {
		throw new Error("the quest tool draws neither its call nor its result");
	}
	return tool as Drawing;
}

function text(drawn: Drawn): string {
	return drawn
		.render(400)
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd();
}

function answer(body: string, details: object) {
	return { content: [{ type: "text", text: body }], details };
}

describe("the quest tool", () => {
	// A collapsed answer ends in pi's expand hint, which reads the theme.
	beforeAll(() => {
		initTheme();
	});

	it("is named quest and tells the agent how to drive it", () => {
		const tool = registered();

		expect(tool.name).toBe("quest");
		expect(tool.promptGuidelines?.join("\n")).toContain("quest");
	});

	it("draws its call as the action and the title it was given", () => {
		const drawn = drawing().renderCall(
			{ action: "create", title: "Split the index", id: "QEST-X" },
			theme,
			undefined,
		);

		expect(text(drawn)).toMatch(/quest.* create.*Split the index/);
	});

	it("draws a refusal as its guidance, in the error colour", () => {
		const drawn = drawing().renderResult(
			answer("What the agent is told.", {
				ok: false,
				guidance: "No quest loaded.",
			}),
			{ expanded: false },
			theme,
			undefined,
		);

		expect(text(drawn)).toBe("<error>No quest loaded.</error>");
	});

	it("draws a long answer as its first line and a count of the rest until expanded", () => {
		const result = answer("First line\nSecond line\nThird line", {
			ok: true,
		});
		const tool = drawing();

		const collapsed = text(
			tool.renderResult(result, { expanded: false }, theme, undefined),
		);
		const expanded = text(
			tool.renderResult(result, { expanded: true }, theme, undefined),
		);

		expect(collapsed).toMatch(/^<success>First line \(\+2 more lines, .+\)/);
		expect(collapsed).not.toContain("Second line");
		expect(expanded).toBe(
			"<success>First line\nSecond line\nThird line</success>",
		);
	});

	it("draws a listing from its rows rather than its text", () => {
		const listing = { rows: [], total: 0, offset: 0, limit: 25, remaining: 0 };
		const result = answer("No quests.\nTry another filter.", {
			ok: true,
			listing,
		});
		const tool = drawing();

		expect(
			text(tool.renderResult(result, { expanded: false }, theme, undefined)),
		).toBe("<success>No quests.</success>");
		expect(
			text(tool.renderResult(result, { expanded: true }, theme, undefined)),
		).toBe("<success>(no matches)</success>");
	});
});

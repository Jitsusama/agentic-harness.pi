import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { QUEST_PARAMETERS } from "../../../../extensions/quest-workflow/wiring/parameters.ts";
import { registerQuestTool } from "../../../../extensions/quest-workflow/wiring/tool.ts";

/**
 * The quest tool as pi is handed it: its name, its arguments, and how
 * its call and result are drawn, pinned so moving where the tool is
 * registered keeps each.
 */

interface Drawn {
	render(width: number): string[];
}

interface ToolDefinition {
	name: string;
	parameters: unknown;
	promptGuidelines: string[];
	renderCall(args: unknown, theme: unknown, context: unknown): Drawn;
	renderResult(
		result: unknown,
		options: { expanded?: boolean },
		theme: unknown,
		context: unknown,
	): Drawn;
}

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

function registered(): ToolDefinition {
	const tools: unknown[] = [];
	const pi = {
		registerTool: (tool: unknown) => tools.push(tool),
	} as unknown as ExtensionAPI;
	registerQuestTool(pi, createQuestState({ questsRoot: "/nowhere" }));
	expect(tools, "one tool registered").toHaveLength(1);
	return tools[0] as ToolDefinition;
}

function text(drawn: Drawn): string {
	return drawn.render(200).join("\n").trimEnd();
}

describe("the quest tool", () => {
	// A collapsed answer ends in pi's expand hint, which reads the theme.
	beforeAll(() => {
		initTheme();
	});

	it("is named quest and takes the quest parameters", () => {
		const tool = registered();

		expect({ name: tool.name, parameters: tool.parameters }).toEqual({
			name: "quest",
			parameters: QUEST_PARAMETERS,
		});
		expect(tool.promptGuidelines.length).toBeGreaterThan(0);
	});

	it("draws its call as the action and the title it was given", () => {
		const drawn = registered().renderCall(
			{ action: "create", title: "Split the index", id: "QEST-X" },
			theme,
			undefined,
		);

		expect(text(drawn)).toContain("quest create Split the index");
	});

	it("draws a refusal as its guidance", () => {
		const drawn = registered().renderResult(
			{
				content: [{ type: "text", text: "No quest loaded." }],
				details: { ok: false, guidance: "No quest loaded." },
			},
			{ expanded: false },
			theme,
			undefined,
		);

		expect(text(drawn)).toBe("No quest loaded.");
	});

	it("draws a long answer collapsed to its first line, and whole when expanded", () => {
		const result = {
			content: [{ type: "text", text: "First line\nSecond line\nThird line" }],
			details: { ok: true },
		};
		const tool = registered();

		const collapsed = text(
			tool.renderResult(result, { expanded: false }, theme, undefined),
		);
		const expanded = text(
			tool.renderResult(result, { expanded: true }, theme, undefined),
		);

		expect(collapsed).toContain("First line");
		expect(collapsed).not.toContain("Third line");
		expect(expanded).toContain("Third line");
	});
});

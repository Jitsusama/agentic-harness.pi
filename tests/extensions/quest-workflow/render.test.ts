import { describe, expect, it } from "vitest";
import {
	renderStatus,
	renderWidget,
	sessionNameFor,
} from "../../../extensions/quest-workflow/render";

const identityTheme = {
	fg: (_token: string, text: string) => text,
} as unknown as Parameters<typeof renderStatus>[1];

describe("sessionNameFor", () => {
	it("returns undefined when no title is supplied", () => {
		expect(sessionNameFor(null)).toBeUndefined();
	});

	it("preserves a title that fits within the limit", () => {
		expect(sessionNameFor("Hello world")).toBe("Hello World");
	});

	it("Title Cases each whitespace-separated word", () => {
		expect(sessionNameFor("quest workflow ux")).toBe("Quest Workflow Ux");
	});

	it("preserves exactly twenty characters with no ellipsis", () => {
		expect(sessionNameFor("Twenty Letters Total")).toBe("Twenty Letters Total");
	});

	it("truncates a longer title to nineteen characters plus an ellipsis", () => {
		const out = sessionNameFor("Quest Workflow UX Iteration Plan") as string;
		expect(out.length).toBe(20);
		expect(out.endsWith("\u2026")).toBe(true);
		expect(out).toBe("Quest Workflow UX I\u2026");
	});
});

describe("renderStatus", () => {
	it("returns undefined when no quest is loaded", () => {
		expect(
			renderStatus(
				{ questId: null, questKind: null, questStatus: null },
				identityTheme,
			),
		).toBeUndefined();
	});

	it("shows the full id when the width budget allows", () => {
		const out = renderStatus(
			{
				questId: "QEST-20260603-AAA111",
				questKind: "quest",
				questStatus: "active",
			},
			identityTheme,
			80,
		);
		expect(out).toContain("QEST-20260603-AAA111");
		expect(out).toContain("\u25c6");
		expect(out).toContain("\u25cb");
	});

	it("collapses to the Quest label when the width budget is tight", () => {
		const out = renderStatus(
			{
				questId: "QEST-20260603-AAA111",
				questKind: "quest",
				questStatus: "active",
			},
			identityTheme,
			10,
		);
		expect(out).toContain("Quest");
		expect(out).not.toContain("AAA111");
	});

	it("uses one distinct status glyph per lifecycle state", () => {
		const seen = new Set<string>();
		for (const status of [
			"active",
			"paused",
			"blocked",
			"concluded",
			"retired",
		] as const) {
			const out = renderStatus(
				{
					questId: "QEST-20260603-AAA111",
					questKind: "quest",
					questStatus: status,
				},
				identityTheme,
				80,
			) as string;
			const glyph = out.split(" ")[1];
			expect(seen.has(glyph)).toBe(false);
			seen.add(glyph);
		}
	});
});

describe("renderWidget", () => {
	function widget(
		overrides: Partial<Parameters<typeof renderWidget>[0]> = {},
	): string {
		const lines = renderWidget(
			{
				questId: "QEST-20260603-AAA111",
				questTitle: "Quest title",
				documentKind: null,
				documentStage: "idle",
				documentTitle: null,
				done: 0,
				total: 0,
				currentItem: undefined,
				...overrides,
			},
			identityTheme,
			200,
		);
		return lines[0] ?? "";
	}

	it("returns nothing when no quest is loaded", () => {
		expect(
			renderWidget(
				{
					questId: null,
					questTitle: null,
					documentKind: null,
					documentStage: "idle",
					documentTitle: null,
					done: 0,
					total: 0,
				},
				identityTheme,
				80,
			),
		).toEqual([]);
	});

	it("renders the canonical plan-build line for a focused doc with progress", () => {
		expect(
			widget({
				documentKind: "plan",
				documentStage: "draft",
				documentTitle: "Quest Workflow UX Iteration",
				done: 4,
				total: 33,
				currentItem: "Slice 1: flatten disk layout and tighten discovery.",
			}),
		).toBe(
			"Drafting Plan: Quest Workflow UX Iteration \u00b7 5/33 \u2192 Slice 1: flatten disk layout and tighten discovery.",
		);
	});

	it("drops the count and arrow when the body has no checkboxes", () => {
		const out = widget({
			documentKind: "plan",
			documentStage: "draft",
			documentTitle: "Empty plan",
			done: 0,
			total: 0,
		});
		expect(out).toBe("Drafting Plan: Empty plan");
	});

	it("drops the arrow but keeps the count when every box is checked", () => {
		const out = widget({
			documentKind: "plan",
			documentStage: "build",
			documentTitle: "Done plan",
			done: 5,
			total: 5,
		});
		expect(out).toBe("Building Plan: Done plan \u00b7 5/5");
	});

	it("drops the {Stage-Verb} {Kind-Noun}: prefix when the doc is concluded", () => {
		const out = widget({
			documentKind: "plan",
			documentStage: "concluded",
			documentTitle: "Wrapped plan",
			done: 3,
			total: 3,
		});
		expect(out).toBe("Wrapped plan \u00b7 3/3");
	});

	it("falls back to the quest title when no document is focused", () => {
		const out = widget({
			questTitle: "Open quest",
			documentKind: null,
			documentStage: "idle",
			documentTitle: null,
			done: 2,
			total: 8,
			currentItem: "Next thing",
		});
		expect(out).toBe("Open quest \u00b7 3/8 \u2192 Next thing");
	});

	it("emits no glyphs in widget output", () => {
		const out = widget({
			documentKind: "plan",
			documentStage: "draft",
			documentTitle: "Plain plan",
			done: 1,
			total: 3,
			currentItem: "Item three",
		});
		expect(out).not.toMatch(
			/[\u25c6\u25c7\u25c8\u25cb\u25d0\u2298\u25cf\u2297]/,
		);
	});
});

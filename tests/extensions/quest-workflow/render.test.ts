import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	renderWidget,
	sessionNameFor,
} from "../../../extensions/quest-workflow/render";

const identityTheme = {
	fg: (_token: string, text: string) => text,
} as unknown as Parameters<typeof renderWidget>[1];

const taggingTheme = {
	fg: (token: string, text: string) => `<${token}>${text}`,
} as unknown as Parameters<typeof renderWidget>[1];

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

	it("prefixes the stable short quest id when the id is supplied", () => {
		expect(sessionNameFor("Alpha", "QEST-20260712-KE2P5K")).toBe(
			"KE2P5K Alpha",
		);
	});

	it("shows the short id alone when there is no title", () => {
		expect(sessionNameFor(null, "QEST-20260712-KE2P5K")).toBe("KE2P5K");
	});

	it("keeps the short id whole and truncates only the title", () => {
		const out = sessionNameFor(
			"A Very Long Quest Title That Overflows",
			"QEST-20260712-KE2P5K",
		) as string;
		expect(out.length).toBe(20);
		expect(out.startsWith("KE2P5K ")).toBe(true);
		expect(out.endsWith("\u2026")).toBe(true);
	});
});

describe("the widget's quest marks", () => {
	const base = {
		questId: "QEST-20260603-AAA111",
		questTitle: "Quest title",
		documentKind: null,
		documentStage: "idle" as const,
		documentTitle: null,
		done: 0,
		total: 0,
	};

	it("leads with the kind and status glyphs, coloured, and the text quiet", () => {
		const [line] = renderWidget(
			{ ...base, questKind: "sidequest", questStatus: "active" },
			taggingTheme,
			200,
		);
		expect(line).toBe("<accent>\u25c7 <warning>\u25cb <muted>Quest title");
	});

	it("never carries the quest id, which lives in quest show", () => {
		const [line] = renderWidget(
			{ ...base, questKind: "quest", questStatus: "active" },
			identityTheme,
			200,
		);
		expect(line).not.toContain("AAA111");
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
			const [line] = renderWidget(
				{ ...base, questKind: "quest", questStatus: status },
				identityTheme,
				200,
			);
			const glyph = (line ?? "").split(" ")[1] ?? "";
			expect(seen.has(glyph)).toBe(false);
			seen.add(glyph);
		}
	});

	it("keeps the line within the width, marks included", () => {
		const [line] = renderWidget(
			{
				...base,
				questKind: "quest",
				questStatus: "active",
				questTitle: "A title long enough to need cutting at forty columns",
			},
			identityTheme,
			40,
		);
		expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(39);
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
				currentItem: "Short next step.",
			}),
		).toBe(
			"Drafting Plan: Quest Workflow UX Iteration \u00b7 5/33 \u2192 Short next step.",
		);
	});

	it("truncates a long trailer to the cap with an ellipsis", () => {
		const out = widget({
			documentKind: "plan",
			documentStage: "draft",
			documentTitle: "Long item plan",
			done: 0,
			total: 5,
			currentItem:
				"Lift QuestRowExpanded and the tree node shape into lib/internal/quest/ so both sides share the same definitions.",
		});
		const arrow = out.split("\u2192 ")[1] ?? "";
		// trimEnd before the ellipsis can shave one column,
		// so the cap is inclusive rather than exact.
		expect(arrow.length).toBeLessThanOrEqual(40);
		expect(arrow.length).toBeGreaterThan(35);
		expect(arrow.endsWith("\u2026")).toBe(true);
	});

	it("strips markdown chrome from the trailer source", () => {
		const out = widget({
			documentKind: "plan",
			documentStage: "draft",
			documentTitle: "Chrome plan",
			done: 0,
			total: 5,
			currentItem: "Lift `QuestRowExpanded` and the **tree** node shape.",
		});
		expect(out).toContain("QuestRowExpanded");
		expect(out).toContain("tree");
		expect(out).not.toMatch(/`/);
		expect(out).not.toMatch(/\*/);
	});

	it("preserves underscores inside snake_case identifiers", () => {
		// The chrome strip used to delete every underscore,
		// turning identifiers like `internal_quest` into
		// `internalquest`. Snake_case is content, not chrome.
		const out = widget({
			documentKind: "plan",
			documentStage: "draft",
			documentTitle: "Snake plan",
			done: 0,
			total: 5,
			currentItem: "Move helpers into the internal_quest module.",
		});
		expect(out).toContain("internal_quest");
	});

	it("strips emphasis underscores when they wrap a word", () => {
		const out = widget({
			documentKind: "plan",
			documentStage: "draft",
			documentTitle: "Emphasis plan",
			done: 0,
			total: 5,
			currentItem: "Mark the _critical_ path through the renderer.",
		});
		expect(out).toContain("critical");
		// One-sided strip would leave a trailing underscore;
		// the regex must strip on both sides for emphasis.
		expect(out).not.toMatch(/_/);
	});

	it("strips emphasis chrome that sits next to punctuation", () => {
		// `_critical_.` and similar were stranded by the
		// whitespace-only anchors: the closing marker abuts
		// a period, not whitespace. Anchoring on \W catches
		// punctuation too.
		const out = widget({
			documentKind: "plan",
			documentStage: "draft",
			documentTitle: "Punctuation plan",
			done: 0,
			total: 5,
			currentItem: "Wrap the _critical_, then the **bold**!",
		});
		expect(out).toContain("critical");
		expect(out).toContain("bold");
		expect(out).not.toMatch(/_/);
		expect(out).not.toMatch(/\*/);
	});

	it("truncates the whole line to width minus the pi indent", () => {
		// Pi renders the widget through `new Text(line, 1, 0)`,
		// so the effective render width is width - 1. Anything
		// past that wraps onto a second visible row, which is
		// the regression this test pins down.
		const lines = renderWidget(
			{
				questId: "QEST-20260603-AAA111",
				questTitle: "Quest title",
				documentKind: "plan",
				documentStage: "draft",
				documentTitle: "A title that on its own already fills the budget",
				done: 0,
				total: 5,
				currentItem: "and a trailer that pushes past the right edge.",
			},
			identityTheme,
			60,
		);
		expect(lines.length).toBe(1);
		// truncateToWidth wraps the result in ANSI resets, so
		// measure visible width rather than raw string length.
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(59);
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

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

	it("leads with the kind and status glyphs, the status coloured, and the text quiet", () => {
		const [line] = renderWidget(
			{ ...base, questKind: "sidequest", questStatus: "active" },
			taggingTheme,
			200,
		);
		// The kind is muted, not the accent: this line is on screen all
		// session, and the accent is kept for where the keys go.
		expect(
			line?.startsWith("<muted>\u25c7 <warning>\u25cb <muted>Quest title "),
		).toBe(true);
	});

	it("dims the id", () => {
		// Real colour codes, which take no columns, so the padding is
		// measured as it would be on screen.
		const sgr: Record<string, number> = {
			accent: 36,
			warning: 33,
			muted: 90,
			dim: 2,
		};
		const colourTheme = {
			fg: (token: string, text: string) => `\x1b[${sgr[token]}m${text}\x1b[0m`,
		} as unknown as Parameters<typeof renderWidget>[1];
		const [line] = renderWidget(
			{ ...base, questKind: "quest", questStatus: "active" },
			colourTheme,
			80,
		);
		expect(line).toContain("\x1b[2mQEST-20260603-AAA111");
		expect(visibleWidth(line ?? "")).toBe(79);
	});

	it("ends with the quest id, dimmed and right-aligned to the width", () => {
		const [line] = renderWidget(
			{ ...base, questKind: "quest", questStatus: "active" },
			identityTheme,
			80,
		);
		expect(line?.endsWith(" QEST-20260603-AAA111")).toBe(true);
		expect(visibleWidth(line ?? "")).toBe(79);
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

describe("the widget short of room", () => {
	const input = {
		questId: "QEST-20261012-DGXMKM",
		questTitle: "The Next Evolution",
		documentKind: "plan" as const,
		documentStage: "build" as const,
		documentTitle: "Quiet Footer",
		done: 1,
		total: 5,
		currentItem: "wire the widget",
	};

	function at(width: number): string {
		const [line] = renderWidget(input, identityTheme, width);
		expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(width - 1);
		expect(line?.endsWith(" QEST-20261012-DGXMKM")).toBe(true);
		return (line ?? "").replace(/ +QEST-20261012-DGXMKM$/, "");
	}

	it("shows everything when it fits", () => {
		expect(at(200)).toBe(
			"The Next Evolution \u00b7 Building Plan: Quiet Footer \u00b7 2/5 \u2192 wire the widget",
		);
	});

	it("gives up the next item first", () => {
		expect(at(80)).toBe(
			"The Next Evolution \u00b7 Building Plan: Quiet Footer \u00b7 2/5",
		);
	});

	it("then the document, keeping the quest and its step", () => {
		expect(at(60)).toBe("The Next Evolution \u00b7 2/5");
	});

	it("then shortens the quest title", () => {
		const out = at(40);
		expect(out.endsWith("\u2026 \u00b7 2/5")).toBe(true);
		expect(out.startsWith("The Next")).toBe(true);
		// Cut as plain text, so no reset lands inside the muted span.
		expect(out).not.toContain("\x1b");
	});

	it("keeps the step and the id when nothing else fits", () => {
		expect(at(30)).toBe("2/5");
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
		// The activity alone: the id and the padding before it are
		// covered by the marks and collapse cases.
		return (lines[0] ?? "").replace(/ +QEST-20260603-AAA111$/, "");
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
			"Quest title \u00b7 Drafting Plan: Quest Workflow UX Iteration \u00b7 5/33 \u2192 Short next step.",
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
		expect(out).toBe("Quest title \u00b7 Drafting Plan: Empty plan");
	});

	it("drops the arrow but keeps the count when every box is checked", () => {
		const out = widget({
			documentKind: "plan",
			documentStage: "build",
			documentTitle: "Done plan",
			done: 5,
			total: 5,
		});
		expect(out).toBe("Quest title \u00b7 Building Plan: Done plan \u00b7 5/5");
	});

	it("drops the {Stage-Verb} {Kind-Noun}: prefix when the doc is concluded", () => {
		const out = widget({
			documentKind: "plan",
			documentStage: "concluded",
			documentTitle: "Wrapped plan",
			done: 3,
			total: 3,
		});
		expect(out).toBe("Quest title \u00b7 Wrapped plan \u00b7 3/3");
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

	it("names the quest ahead of the focused document", () => {
		const out = widget({
			questTitle: "The Next Evolution",
			documentKind: "plan",
			documentStage: "build",
			documentTitle: "Quiet Footer",
			done: 1,
			total: 5,
		});
		expect(out).toBe(
			"The Next Evolution \u00b7 Building Plan: Quiet Footer \u00b7 2/5",
		);
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

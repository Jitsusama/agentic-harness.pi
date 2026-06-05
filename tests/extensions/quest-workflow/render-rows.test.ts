import { describe, expect, it } from "vitest";
import {
	collapseListingPreview,
	DEFAULT_LISTING_LIMIT,
	isListingDetails,
	type ListingDetails,
	type ListingFlatRow,
	paginate,
	type QuestRowBrief,
	type QuestRowExpanded,
	questGlyphLegend,
	renderListing,
	renderListingExpanded,
	renderRowBrief,
	renderRowExpanded,
	renderRowGlyph,
} from "../../../extensions/quest-workflow/render-rows";

const baseBrief: QuestRowBrief = {
	id: "QEST-20260603-AAA111",
	kind: "quest",
	status: "active",
	priority: "active",
	title: "Quest Workflow UX Iteration",
};

describe("renderRowBrief", () => {
	it("renders id and parsable kind, status, priority words and title", () => {
		expect(renderRowBrief(baseBrief)).toBe(
			"QEST-20260603-AAA111 kind=quest status=active priority=active Quest Workflow UX Iteration",
		);
	});

	it("falls back to (untitled) when the row carries a null title", () => {
		expect(renderRowBrief({ ...baseBrief, title: null })).toContain(
			"(untitled)",
		);
	});

	it("carries the priority word", () => {
		expect(renderRowBrief({ ...baseBrief, priority: "driving" })).toContain(
			"priority=driving",
		);
	});
});

describe("renderRowGlyph", () => {
	it("renders id, kind glyph, status glyph and title on one line", () => {
		expect(renderRowGlyph(baseBrief)).toBe(
			"QEST-20260603-AAA111 \u25c6 \u25cb Quest Workflow UX Iteration",
		);
	});

	it("uses different kind glyphs for quest, subquest and sidequest", () => {
		expect(renderRowGlyph({ ...baseBrief, kind: "quest" })).toContain("\u25c6");
		expect(renderRowGlyph({ ...baseBrief, kind: "subquest" })).toContain(
			"\u25c8",
		);
		expect(renderRowGlyph({ ...baseBrief, kind: "sidequest" })).toContain(
			"\u25c7",
		);
	});
});

describe("questGlyphLegend", () => {
	it("maps the kind and status glyphs to their words", () => {
		const legend = questGlyphLegend();
		expect(legend).toContain("\u25c6");
		expect(legend).toContain("quest");
		expect(legend).toContain("active");
	});
});

describe("renderRowExpanded", () => {
	const base: QuestRowExpanded = {
		...baseBrief,
		priority: "driving",
		parent: null,
		updated: "2026-06-03",
	};

	it("renders the glyph row and a metadata line below it", () => {
		const out = renderRowExpanded(base);
		const [first, second] = out.split("\n");
		expect(first).toBe(renderRowGlyph(base));
		expect(second).toContain("priority: driving");
		expect(second).toContain("parent: none");
		expect(second).toContain("updated: 2026-06-03");
	});

	it("emits a parent id when the row has one", () => {
		const out = renderRowExpanded({ ...base, parent: "QEST-20260603-PRT777" });
		expect(out).toContain("parent: QEST-20260603-PRT777");
		expect(out).not.toContain("parent: none");
	});

	it("includes summary, cast, documents and recent journey when supplied", () => {
		const out = renderRowExpanded({
			...base,
			summary: "Iterate on quest UX based on dogfooding.",
			cast: [
				{ role: "owner", subject: "Joel Gerber" },
				{ role: "reviewer", subject: "Evan" },
			],
			documents: [{ id: "PLAN-20260603-2XXWYU", stage: "build" }],
			recentJourney: [{ date: "2026-06-03", prose: "Slice 1 landed." }],
		});
		expect(out).toContain("summary: Iterate on quest UX based on dogfooding.");
		expect(out).toContain("cast: Joel Gerber (owner), Evan (reviewer)");
		expect(out).toContain("docs: PLAN-20260603-2XXWYU (build)");
		expect(out).toContain("recent journey:");
		expect(out).toContain("2026-06-03: Slice 1 landed.");
	});

	it("omits optional sections when their arrays are empty", () => {
		const out = renderRowExpanded({
			...base,
			cast: [],
			documents: [],
			recentJourney: [],
		});
		expect(out).not.toContain("cast:");
		expect(out).not.toContain("docs:");
		expect(out).not.toContain("recent journey:");
	});
});

describe("paginate", () => {
	const items = Array.from({ length: 60 }, (_, i) => `row${i}`);

	it("defaults to the listing limit and offset zero", () => {
		const view = paginate(items);
		expect(view.limit).toBe(DEFAULT_LISTING_LIMIT);
		expect(view.offset).toBe(0);
		expect(view.rows.length).toBe(DEFAULT_LISTING_LIMIT);
		expect(view.remaining).toBe(items.length - DEFAULT_LISTING_LIMIT);
	});

	it("respects explicit limit and offset", () => {
		const view = paginate(items, { limit: 10, offset: 25 });
		expect(view.rows.length).toBe(10);
		expect(view.rows[0]).toBe("row25");
		expect(view.remaining).toBe(items.length - 35);
	});

	it("clamps negative inputs and a limit of zero", () => {
		const view = paginate(items, { limit: 0, offset: -10 });
		expect(view.limit).toBeGreaterThanOrEqual(1);
		expect(view.offset).toBe(0);
	});

	it("reports zero remaining when offset is past the end", () => {
		const view = paginate(items, { offset: 1000, limit: 10 });
		expect(view.rows.length).toBe(0);
		expect(view.remaining).toBe(0);
	});
});

describe("renderListing", () => {
	it("returns (no matches) on an empty page", () => {
		const view = paginate<string>([], {});
		expect(renderListing([], view)).toBe("(no matches)");
	});

	it("renders rows without a tail when nothing remains", () => {
		const view = paginate(["a", "b", "c"]);
		const out = renderListing(["a", "b", "c"], view);
		expect(out).toBe("a\nb\nc");
	});

	it("appends an 'and N more' tail when more rows remain", () => {
		const items = Array.from({ length: 30 }, (_, i) => `row${i}`);
		const view = paginate(items, { limit: 5 });
		const out = renderListing(view.rows, view);
		expect(out).toContain("... and 25 more (offset 5 to continue)");
	});
});

function makeRow(overrides: Partial<ListingFlatRow> = {}): ListingFlatRow {
	return {
		id: "QEST-20260603-AAA111",
		kind: "quest",
		status: "active",
		title: "Sample",
		priority: "active",
		parent: null,
		updated: "2026-06-03",
		depth: 0,
		...overrides,
	};
}

describe("renderListingExpanded", () => {
	it("renders each row as a block of expanded lines", () => {
		const details: ListingDetails = {
			rows: [makeRow({ summary: "A short summary." })],
			total: 1,
			offset: 0,
			limit: 25,
			remaining: 0,
		};
		const out = renderListingExpanded(details);
		expect(out).toContain("QEST-20260603-AAA111");
		expect(out).toContain("priority: active");
		expect(out).toContain("parent: none");
		expect(out).toContain("updated: 2026-06-03");
		expect(out).toContain("summary: A short summary.");
	});

	it("indents tree-shaped rows by depth", () => {
		const details: ListingDetails = {
			rows: [makeRow(), makeRow({ id: "QEST-20260603-CCC222", depth: 1 })],
			total: 2,
			offset: 0,
			limit: 25,
			remaining: 0,
		};
		const out = renderListingExpanded(details);
		const lines = out.split("\n");
		const depth1Line = lines.find((l) => l.includes("QEST-20260603-CCC222"));
		expect(depth1Line?.startsWith("  ")).toBe(true);
	});

	it("surfaces the empty-page tail when total > 0 but rows empty", () => {
		const details: ListingDetails = {
			rows: [],
			total: 30,
			offset: 100,
			limit: 25,
			remaining: 0,
		};
		expect(renderListingExpanded(details)).toBe(
			"(empty page; 30 total, try offset 0)",
		);
	});

	it("shows (no matches) when the set is truly empty", () => {
		const details: ListingDetails = {
			rows: [],
			total: 0,
			offset: 0,
			limit: 25,
			remaining: 0,
		};
		expect(renderListingExpanded(details)).toBe("(no matches)");
	});

	it("appends a pagination tail when more remain", () => {
		const details: ListingDetails = {
			rows: [makeRow()],
			total: 30,
			offset: 0,
			limit: 1,
			remaining: 29,
		};
		expect(renderListingExpanded(details)).toContain(
			"... and 29 more (offset 1 to continue)",
		);
	});
});

describe("renderRowExpanded", () => {
	it("suppresses the updated field on sparse rows with no value", () => {
		// The synthetic (orphans) tree node arrives without
		// a discovery entry, so updated is empty. The
		// expanded view must not paint a dangling
		// `updated:` field with nothing after it.
		const row: QuestRowExpanded = {
			id: "(orphans)",
			kind: "quest",
			status: "active",
			title: "Sparse",
			priority: "someday",
			parent: null,
			updated: "",
		};
		const out = renderRowExpanded(row);
		expect(out).toContain("priority: someday");
		expect(out).toContain("parent: none");
		expect(out).not.toContain("updated:");
	});

	it("emits the updated field when the row carries a date", () => {
		const row: QuestRowExpanded = {
			id: "QEST-20260603-AAA111",
			kind: "quest",
			status: "active",
			title: "Real",
			priority: "active",
			parent: null,
			updated: "2026-06-03",
		};
		expect(renderRowExpanded(row)).toContain("updated: 2026-06-03");
	});
});

describe("isListingDetails", () => {
	it("accepts a well-formed payload", () => {
		const payload: ListingDetails = {
			rows: [],
			total: 0,
			offset: 0,
			limit: 25,
			remaining: 0,
		};
		expect(isListingDetails(payload)).toBe(true);
	});

	it("rejects undefined, null and non-objects", () => {
		expect(isListingDetails(undefined)).toBe(false);
		expect(isListingDetails(null)).toBe(false);
		expect(isListingDetails("listing")).toBe(false);
		expect(isListingDetails(7)).toBe(false);
	});

	it("rejects payloads missing required fields or with wrong types", () => {
		expect(isListingDetails({})).toBe(false);
		expect(
			isListingDetails({
				rows: "not-an-array",
				total: 0,
				offset: 0,
				limit: 0,
				remaining: 0,
			}),
		).toBe(false);
		expect(
			isListingDetails({
				rows: [],
				total: "0",
				offset: 0,
				limit: 0,
				remaining: 0,
			}),
		).toBe(false);
	});
});

describe("collapseListingPreview", () => {
	const baseListing: ListingDetails = {
		rows: [],
		total: 0,
		offset: 0,
		limit: 25,
		remaining: 0,
	};

	it("falls back to the first content line when there are no rows", () => {
		expect(collapseListingPreview(baseListing, "(no matches)")).toBe(
			"(no matches)",
		);
	});

	it("shows the first row alone when total is one", () => {
		const listing: ListingDetails = {
			...baseListing,
			rows: [makeRow()],
			total: 1,
		};
		expect(
			collapseListingPreview(listing, "QEST-20260603-AAA111 ◆ ○ Sample"),
		).toBe("QEST-20260603-AAA111 ◆ ○ Sample");
	});

	it("appends a +N more suffix when the total exceeds one", () => {
		const listing: ListingDetails = {
			...baseListing,
			rows: [makeRow()],
			total: 7,
			remaining: 6,
		};
		expect(collapseListingPreview(listing, "first row text")).toBe(
			"first row text (+6 more)",
		);
	});

	it("counts only what's still hidden under pagination", () => {
		// At offset 5 with limit 5 of a 30-row set, the
		// preview is showing row 5; rows 6..9 sit on the
		// same page (4 more) and rows 10..29 sit later (20
		// more), so the count is 24, not total-1 = 29.
		const rows = Array.from({ length: 5 }, () => makeRow());
		const listing: ListingDetails = {
			rows,
			total: 30,
			offset: 5,
			limit: 5,
			remaining: 20,
		};
		expect(collapseListingPreview(listing, "row5 text")).toBe(
			"row5 text (+24 more)",
		);
	});
});

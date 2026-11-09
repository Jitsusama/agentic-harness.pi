import { describe, expect, it } from "vitest";
import { matchesQuery } from "../../../extensions/quest-workflow/lookup.ts";
import type { QuestEntry } from "../../../lib/internal/quest/discovery.ts";
import type { QuestFrontMatter } from "../../../lib/quest/types.ts";

function entry(opts: {
	title?: string;
	id?: string;
	body?: string;
	aliases?: { type: string; value: string }[];
}): QuestEntry {
	const fm = {
		id: opts.id ?? "QEST-20260604-AAA111",
		kind: "quest",
		parent: null,
		status: "active",
		priority: "active",
		rank: 1,
		started: "2026-06-04",
		updated: "2026-06-04",
		aliases: opts.aliases ?? [],
		sessions: [],
	} as QuestFrontMatter;
	return {
		dir: "/q",
		doc: { frontMatter: fm, body: opts.body ?? "", title: opts.title },
		documents: [],
	} as QuestEntry;
}

describe("matchesQuery", () => {
	it("matches when every token appears across fields", () => {
		const e = entry({
			title: "Repair the Quest Workflow",
			body: "config loader",
		});
		expect(
			matchesQuery(e, "quest config"),
			"every token is found across title and body",
		).toBe(true);
	});

	it("fails when one token is missing", () => {
		const e = entry({ title: "Repair the Quest Workflow" });
		expect(
			matchesQuery(e, "quest banana"),
			"one missing token fails the match",
		).toBe(false);
	});

	it("is case-insensitive and order-independent", () => {
		const e = entry({ title: "Quest Workflow Repair" });
		expect(
			matchesQuery(e, "REPAIR workflow"),
			"case and order do not matter",
		).toBe(true);
	});

	it("matches tokens spread across title, id and aliases", () => {
		const e = entry({
			title: "Reopening core",
			id: "QEST-20260604-ZZZ999",
			aliases: [{ type: "github-pr", value: "Shopify/world#42" }],
		});
		expect(
			matchesQuery(e, "reopening ZZZ999 world"),
			"tokens spread across title, id and aliases match",
		).toBe(true);
	});

	it("treats an empty query as matching everything", () => {
		expect(
			matchesQuery(entry({ title: "anything" }), "   "),
			"a blank query matches everything",
		).toBe(true);
	});
});

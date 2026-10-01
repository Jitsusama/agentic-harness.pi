import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	paragraphRef,
	unitsOf,
} from "../../../../lib/compaction/selection/units.ts";
import {
	entryTexts,
	PAGE_CHARS,
	PAGE_HITS,
	RECALL_TOOL,
	recall,
	search,
} from "../../../../lib/internal/recall/session.ts";

const base = { parentId: null, timestamp: "2026-09-30T12:00:00.000Z" };

function user(id: string, text: string): SessionEntry {
	return {
		...base,
		type: "message",
		id,
		message: { role: "user", content: text, timestamp: 1 },
	} as unknown as SessionEntry;
}

function assistant(id: string, content: unknown[]): SessionEntry {
	return {
		...base,
		type: "message",
		id,
		message: { role: "assistant", content, timestamp: 2 },
	} as unknown as SessionEntry;
}

function said(id: string, text: string): SessionEntry {
	return assistant(id, [{ type: "text", text }]);
}

function called(id: string, callId: string, name: string, args: unknown) {
	return assistant(id, [
		{ type: "toolCall", id: callId, name, arguments: args },
	]);
}

function result(id: string, callId: string, text: string): SessionEntry {
	return {
		...base,
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 3,
		},
	} as unknown as SessionEntry;
}

function compaction(id: string, summary: string): SessionEntry {
	return {
		...base,
		type: "compaction",
		id,
		summary,
		firstKeptEntryId: "x",
		tokensBefore: 1,
	} as unknown as SessionEntry;
}

describe("reading a session's log as text", () => {
	it("reads a tool call with its result, under the entry that made it", () => {
		const texts = entryTexts([
			called("a1", "t1", "bash", { command: "git log -1" }),
			result("r1", "t1", "3632d47 fix(observability): one ledger"),
		]);
		expect(texts).toEqual([
			{
				id: "a1",
				text: 'bash {"command":"git log -1"}\n3632d47 fix(observability): one ledger',
			},
		]);
	});

	it("reads summaries, and leaves out entries that say nothing", () => {
		const texts = entryTexts([
			compaction("c1", "## Goal\nShip the fix."),
			{ ...base, type: "label", id: "l1", targetId: "c1" } as never,
		]);
		expect(texts.map((t) => t.id)).toEqual(["c1"]);
	});

	it("leaves its own earlier searches out, so their hits are not found twice", () => {
		const texts = entryTexts([
			user("u1", "the flake"),
			called("a1", "t1", RECALL_TOOL, { query: "flake" }),
			result("r1", "t1", "[u1] the flake"),
		]);
		expect(texts.map((t) => t.id)).toEqual(["u1"]);
	});
});

describe("searching the log", () => {
	const log = [
		user("u1", "fix the commit message"),
		said("a1", "every commit ends with a Co-authored-by trailer"),
		said("a2", "the commit is pushed"),
		said("a3", "unrelated"),
	];

	it("matches any word of the query, ranking the rarer one first", () => {
		const hits = search(entryTexts(log), "commit Co-authored-by");
		expect(hits.map((h) => h.id)).toEqual(["a1", "u1", "a2"]);
	});

	it("keeps the log's order among entries that score the same", () => {
		const hits = search(entryTexts(log), "commit");
		expect(hits.map((h) => h.id)).toEqual(["u1", "a1", "a2"]);
	});

	it("shows a window around the first match of a long entry", () => {
		const long = `${"a".repeat(5000)} needle ${"b".repeat(5000)}`;
		const [hit] = search(entryTexts([said("a1", long)]), "needle");
		expect(hit?.snippet).toContain("needle");
		expect(hit?.snippet.length).toBeLessThan(1000);
	});
});

describe("a recall", () => {
	it("reads one entry by id, whole, naming the entries either side", () => {
		const log = [
			user("u1", "hello"),
			said("a1", "the answer"),
			user("u2", "thanks"),
		];
		expect(recall(log, { entryId: "a1" })).toMatchObject({
			kind: "entry",
			view: "[a1] the answer\n\nBefore it: u1. After it: u2.",
			cut: false,
		});
		expect(recall(log, { entryId: "u1" }).view).toBe(
			"[u1] hello\n\nAfter it: a1.",
		);
	});

	it("reads the latest entry saying a paragraph, by its reference", () => {
		const rule = "Always sign every commit before pushing.";
		const log = [
			user("u1", rule),
			said("a1", "Understood."),
			user("u7", `As I said before.\n\n${rule}`),
		];
		const [unit] = unitsOf(log[0] as SessionEntry);
		const ref = paragraphRef(unit?.hash ?? "");
		const answer = recall(log, { entryId: ref });
		expect(answer.kind).toBe("entry");
		expect(answer.view.startsWith(`[u7] (${ref}) As I said before.`)).toBe(
			true,
		);
	});

	it("says plainly when no entry says the paragraph a reference names", () => {
		expect(
			recall([user("u1", "hello there friend")], { entryId: "p:0123456789" }),
		).toMatchObject({
			kind: "none",
			view: expect.stringContaining("Search for its words"),
		});
	});

	it("cuts an entry longer than a page, and says so", () => {
		const answer = recall([said("a1", "x".repeat(PAGE_CHARS * 3))], {
			entryId: "a1",
		});
		expect(answer.kind).toBe("entry");
		if (answer.kind !== "entry") return;
		expect(answer.cut).toBe(true);
		expect(answer.view.length).toBeLessThan(PAGE_CHARS + 20);
		expect(answer.entry.text).toHaveLength(PAGE_CHARS * 3);
	});

	it("says plainly when an id is not in the log, and that the log may have been rebuilt", () => {
		expect(recall([user("u1", "hi")], { entryId: "zz" })).toMatchObject({
			kind: "none",
			view: expect.stringMatching(/zz.*rebuilt.*search/s),
		});
	});

	it("pages hits, naming the ones it leaves for later", () => {
		const log = Array.from({ length: PAGE_HITS + 3 }, (_, i) =>
			said(`a${i}`, `the widget ${i}`),
		);
		const first = recall(log, { query: "widget" });
		expect(first.kind).toBe("hits");
		if (first.kind !== "hits") return;
		expect(first.view.split("\n\n")).toHaveLength(PAGE_HITS);
		expect(first.hits).toHaveLength(PAGE_HITS + 3);
		expect(first.more).toContain("a10 a11 a12");
		expect(first.more).toContain("page 2");

		const second = recall(log, { query: "widget", page: 2 });
		expect(second.kind === "hits" && second.more).toBeFalsy();
		expect(second.view.split("\n\n")).toHaveLength(3);
	});

	it("keeps a page within its characters however few hits it holds", () => {
		const log = Array.from({ length: 40 }, (_, i) =>
			said(`a${i}`, `widget ${"w".repeat(800)}`),
		);
		const answer = recall(log, { query: "widget" });
		expect(answer.view.length).toBeLessThanOrEqual(PAGE_CHARS);
	});

	it("answers a search that finds nothing, or a page past the end, in words", () => {
		const log = [said("a1", "the widget")];
		expect(recall(log, { query: "gadget" }).kind).toBe("none");
		expect(recall(log, { query: "widget", page: 4 }).view).toContain(
			"no page 4",
		);
		expect(recall(log, {}).kind).toBe("none");
	});
});

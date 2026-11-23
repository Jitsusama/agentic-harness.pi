/**
 * Recall over the history a branch left on disk, read a line at a time:
 * it answers exactly what reading every log whole answers, while
 * keeping text only for the entries the answer shows.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	paragraphRef,
	unitsOf,
} from "../../../../lib/compaction/selection/units.ts";
import {
	answer,
	askedBy,
	markEntries,
	PAGE_HITS,
	type RecallRequest,
	recall,
} from "../../../../lib/internal/logs/recall.ts";
import { markedOnDisk } from "../../../../lib/internal/logs/recall-on-disk.ts";
import {
	ancestry,
	ROLLOVER_RECORD,
} from "../../../../lib/internal/session/rollover.ts";

const at = "2026-09-30T12:00:00.000Z";

type Line = Record<string, unknown>;

function header(id: string): Line {
	return { type: "session", id, timestamp: at, cwd: "/" };
}

function user(id: string, parentId: string | null, text: string): Line {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at,
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function said(id: string, parentId: string | null, text: string): Line {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: 2,
		},
	};
}

function called(
	id: string,
	parentId: string | null,
	callId: string,
	name: string,
	args: unknown,
): Line {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: `calling ${name}` },
				{ type: "toolCall", id: callId, name, arguments: args },
			],
			timestamp: 2,
		},
	};
}

function result(
	id: string,
	parentId: string | null,
	callId: string,
	text: string,
): Line {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at,
		message: {
			role: "toolResult",
			toolCallId: callId,
			content: [{ type: "text", text }],
			timestamp: 3,
		},
	};
}

function compaction(
	id: string,
	parentId: string,
	firstKeptEntryId: string,
	summary: string,
): Line {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: at,
		summary,
		firstKeptEntryId,
		tokensBefore: 1,
	};
}

function record(
	id: string,
	parentId: string | null,
	parentSession: string,
	parentLeaf: string,
): Line {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: at,
		customType: ROLLOVER_RECORD,
		data: { parentSession, parentLeaf, dropped: 1, carried: {} },
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "recall-on-disk-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function log(name: string, lines: Line[]): string {
	const path = join(dir, name);
	writeFileSync(
		path,
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
	return path;
}

/** What reading every log whole answers: the oracle. */
function whole(branch: Line[], request: RecallRequest) {
	const entries = [...ancestry(branch), ...branch] as unknown as SessionEntry[];
	return recall(entries, request);
}

/** What the line-at-a-time reader answers. */
function streamed(branch: Line[], request: RecallRequest) {
	const asked = askedBy(request);
	const disk = markedOnDisk(branch, asked);
	const own = markEntries(branch as unknown as SessionEntry[], asked);
	return answer([...disk.marked, ...own], request, asked);
}

/** Many entries on a parent, enough for a second page of hits. */
const MANY = PAGE_HITS + 5;

/**
 * A grandparent with a tool call and its result, a recall call, and a
 * fork off its branch; a parent rolled from it, compacted, with enough
 * matching turns for two pages; and a branch rolled from the parent,
 * carrying one entry over.
 */
function rolledTwice(): { branch: Line[]; logs: string[] } {
	const grandparent = log("grandparent.jsonl", [
		header("g"),
		user("g1", null, "the grandparent flake in the builder"),
		called("g2", "g1", "c1", "bash", { command: "ls flakes" }),
		result("g3", "g2", "c1", "flake output from the builder"),
		called("g4", "g3", "c2", "session_recall", { query: "flake" }),
		result("g5", "g4", "c2", "[x] an earlier flake hit"),
		said("g6", "g1", "an off-branch flake nobody kept"),
		said("g7", "g5", "the grandparent's last word on caching"),
	]);
	const turns: Line[] = [];
	let parentId = "p2";
	for (let i = 0; i < MANY; i++) {
		turns.push(said(`m${i}`, parentId, `turn ${i} saw the flake again`));
		parentId = `m${i}`;
	}
	const parent = log("parent.jsonl", [
		header("p"),
		record("pr", null, grandparent, "g7"),
		user("p1", "pr", "the parent asks about the flake"),
		compaction("p2", "p1", "p1", "summary: the flake was the builder"),
		...turns,
		said("k1", parentId, "the carried flake, kept on both"),
	]);
	const branch = [
		said("k1", null, "the carried flake, kept on both"),
		record("br", "k1", parent, "k1"),
		user("b1", "br", "the newest flake, in memory"),
	];
	return { branch, logs: [grandparent, parent] };
}

describe("recall read a line at a time", () => {
	it("finds what reading every log whole finds, page by page", () => {
		const { branch } = rolledTwice();
		for (const request of [
			{ query: "flake" },
			{ query: "flake", page: 2 },
			{ query: "flake", page: 3 },
			{ query: "grandparent builder" },
			{ query: "output" },
			{ query: "caching summary" },
			{ query: "nothing matches this" },
			{ query: "  " },
			{},
		]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
	});

	it("finds a second page at all, so the page check means something", () => {
		const { branch } = rolledTwice();
		const second = streamed(branch, { query: "flake", page: 2 });
		expect(second.kind).toBe("hits");
	});

	it("leaves recall's own calls and the fork off the branch unsearched", () => {
		const { branch } = rolledTwice();
		const hits = streamed(branch, { query: "earlier off-branch" });
		expect(hits.kind).toBe("none");
	});

	it("reads one entry by id with the same neighbours, across each boundary", () => {
		const { branch } = rolledTwice();
		for (const entryId of ["g1", "g2", "g7", "pr", "p1", "k1", "b1", "zz"]) {
			expect(streamed(branch, { entryId })).toEqual(whole(branch, { entryId }));
		}
	});

	it("reads an entry by a paragraph reference as reading whole does", () => {
		const { branch } = rolledTwice();
		const unit = unitsOf(
			said("x", null, "the grandparent's last word on caching") as never,
		)[0];
		const ref = paragraphRef(unit?.hash ?? "");
		expect(streamed(branch, { entryId: ref }).kind).toBe("entry");
		expect(streamed(branch, { entryId: ref })).toEqual(
			whole(branch, { entryId: ref }),
		);
		expect(streamed(branch, { entryId: "p:ffffffffff" })).toEqual(
			whole(branch, { entryId: "p:ffffffffff" }),
		);
	});

	it("reads a conversation that holds its own log's kept view", () => {
		// A hosted conversation's record names its own log, and the entry
		// before its first kept one as where the older branch ends.
		const file = log("self.jsonl", [
			header("s"),
			user("h1", null, "the first flake of the day"),
			said("h2", "h1", "a reply about the flake"),
			user("h3", "h2", "a later question"),
			compaction("h4", "h3", "h3", "summary of the flake hunt"),
			said("h5", "h4", "the latest flake answer"),
		]);
		const branch = [
			record("r", null, file, "h2"),
			user("h3", "r", "a later question"),
			compaction("h4", "h3", "h3", "summary of the flake hunt"),
			said("h5", "h4", "the latest flake answer"),
		];
		for (const request of [
			{ query: "flake" },
			{ entryId: "h2" },
			{ entryId: "h3" },
		]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
	});

	it("keeps text only for the entries the answer shows", () => {
		const { branch } = rolledTwice();
		const asked = askedBy({ query: "caching" });
		const { marked } = markedOnDisk(branch, asked);
		const carrying = marked.filter(
			(mark) => mark.text !== undefined || mark.snippet !== undefined,
		);
		expect(carrying.map((mark) => mark.id)).toEqual(["g7"]);
	});

	it("says how many logs and bytes it read, and how many entries", () => {
		const { branch, logs } = rolledTwice();
		const disk = markedOnDisk(branch, askedBy({ query: "flake" }));
		expect(disk.logs).toBe(2);
		expect(disk.bytes).toBe(
			logs.reduce((sum, path) => sum + statSync(path).size, 0),
		);
		expect(disk.entries).toBe(ancestry(branch).length);
	});

	it("ends the chain at a parent gone from disk", () => {
		const branch = [
			record("r", null, join(dir, "gone.jsonl"), "x"),
			said("a", "r", "a flake"),
		];
		const disk = markedOnDisk(branch, askedBy({ query: "flake" }));
		expect(disk).toEqual({ marked: [], logs: 0, bytes: 0, entries: 0 });
	});

	it("reads a line cut short by a crash as the end of nothing", () => {
		const path = join(dir, "cut.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify(header("c"))}\n${JSON.stringify(said("c1", null, "a flake before the crash"))}\n{"type":"message","id":"c2"`,
		);
		const branch = [record("r", null, path, "c1"), said("a", "r", "now")];
		for (const request of [{ query: "flake" }, { entryId: "c1" }]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
	});
});

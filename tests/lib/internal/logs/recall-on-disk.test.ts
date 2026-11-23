/**
 * Recall over the history a branch left on disk, read a line at a time:
 * it answers exactly what reading every log whole answers, while
 * keeping text only for the entries the answer shows.
 */

import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
import {
	markedOnDisk,
	NO_BRANCH,
} from "../../../../lib/internal/logs/recall-on-disk.ts";
import {
	type Entry,
	ROLLOVER_RECORD,
	rolledFrom,
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

/**
 * The branch a log held where it was rolled over, the log read whole:
 * from its root to `leaf`, the last line with an id winning.
 */
function branchIn(path: string, leaf: string): Entry[] {
	const byId = new Map<string, Entry>();
	for (const line of readFileSync(path, "utf8").split("\n")) {
		let entry: Entry;
		try {
			entry = JSON.parse(line) as Entry;
		} catch {
			// A blank or a line cut short by a crash holds no entry.
			continue;
		}
		if (entry.type === "session" || typeof entry.id !== "string") continue;
		byId.set(entry.id, entry);
	}
	const walked: Entry[] = [];
	let next = byId.get(leaf);
	while (next) {
		walked.push(next);
		next = next.parentId ? byId.get(next.parentId) : undefined;
	}
	return walked.reverse();
}

/**
 * Everything the logs `branch` rolled over from held on their branches,
 * each log read whole, oldest first and without the entries a newer log
 * carried over: what recall read before it read a line at a time.
 */
function ancestry(branch: readonly Line[]): Entry[] {
	const seen = new Set(branch.map((entry) => entry.id));
	const older: Entry[][] = [];
	let next = rolledFrom(branch);
	const visited = new Set<string>();
	while (next && !visited.has(next.parentSession)) {
		visited.add(next.parentSession);
		let parent: Entry[];
		try {
			parent = branchIn(next.parentSession, next.parentLeaf);
		} catch {
			// A parent gone from disk ends the chain there.
			break;
		}
		older.unshift(parent.filter((entry) => !seen.has(entry.id)));
		for (const entry of parent) seen.add(entry.id);
		next = rolledFrom(parent);
	}
	return older.flat();
}

/** What reading every log whole answers: the oracle. */
function whole(branch: Line[], request: RecallRequest) {
	const entries = [...ancestry(branch), ...branch] as unknown as SessionEntry[];
	return recall(entries, request);
}

/** The ids of the entries an answer's hits name, or none for another kind. */
function hitIds(found: ReturnType<typeof streamed>): string[] {
	return found.kind === "hits" ? found.hits.map((hit) => hit.id) : [];
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
 * fork off its branch; a parent rolled from it, carrying its last entry
 * over, compacted, with enough matching turns for two pages; and a
 * branch rolled from the parent, carrying one entry over.
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
		said("g7", null, "the grandparent's last word on caching"),
		record("pr", "g7", grandparent, "g7"),
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

		const byId = markedOnDisk(branch, askedBy({ entryId: "g2" })).marked;
		expect(
			byId.filter((mark) => mark.text !== undefined).map((mark) => mark.id),
		).toEqual(["g2"]);
	});

	it("says how many logs and bytes it read, and how many entries", () => {
		const { branch, logs } = rolledTwice();
		const disk = markedOnDisk(branch, askedBy({ query: "flake" }));
		expect(disk.logs).toBe(2);
		expect(disk.bytes).toBe(
			logs.reduce((sum, path) => sum + statSync(path).size, 0),
		);
		expect(disk.entries).toBe(ancestry(branch).length);
		expect(disk.readAgain).toBe(0);
	});

	it("counts what it read of a parent that failed partway", () => {
		const branch = [record("r", null, join(dir, "any.jsonl"), "x")];
		function* failing(
			_path: string,
			tally: { bytes: number },
		): Iterable<string> {
			tally.bytes += 7;
			yield JSON.stringify(said("x", null, "a flake"));
			throw Object.assign(new Error("a failed read"), {
				code: "EIO",
				syscall: "read",
			});
		}

		const disk = markedOnDisk(branch, askedBy({ query: "flake" }), failing);
		expect(disk.bytes).toBe(7);
		expect(disk.unread).toEqual({
			path: join(dir, "any.jsonl"),
			reason: "EIO",
		});
	});

	it("ends the chain at a parent gone from disk", () => {
		const branch = [
			record("r", null, join(dir, "gone.jsonl"), "x"),
			said("a", "r", "a flake"),
		];
		const disk = markedOnDisk(branch, askedBy({ query: "flake" }));
		expect(disk).toEqual({
			marked: [],
			logs: 0,
			bytes: 0,
			readAgain: 0,
			entries: 0,
			unread: { path: join(dir, "gone.jsonl"), reason: "ENOENT" },
		});
	});

	it("names a parent that holds none of its record's branch, and reads no further", () => {
		const older = log("older.jsonl", [
			header("o"),
			said("o1", null, "a flake past the parent"),
		]);
		const path = log("leafless.jsonl", [
			header("x"),
			record("x1", null, older, "o1"),
			said("x2", "x1", "a flake, but not the leaf"),
		]);
		for (const parent of [path, dir]) {
			const branch = [
				record("r", null, parent, "missing"),
				said("a", "r", "now"),
			];
			// What was read to learn it holds no branch still counts.
			expect(markedOnDisk(branch, askedBy({ query: "flake" }))).toEqual({
				marked: [],
				logs: 0,
				bytes: parent === path ? statSync(path).size : 0,
				readAgain: 0,
				entries: 0,
				unread: { path: parent, reason: NO_BRANCH },
			});
		}
	});

	it("throws Node's own fault, which carries a code but no system call", () => {
		const branch = [record("r", null, join(dir, "any.jsonl"), "x")];
		const failing = (): Iterable<string> => {
			throw Object.assign(new Error("a bad argument"), {
				code: "ERR_INVALID_ARG_TYPE",
			});
		};

		expect(() =>
			markedOnDisk(branch, askedBy({ query: "flake" }), failing),
		).toThrow("a bad argument");
	});

	it("throws an error of its own rather than take it for a missing log", () => {
		const branch = [record("r", null, join(dir, "any.jsonl"), "x")];
		const failing = (): Iterable<string> => {
			throw new Error("a fault in the reader");
		};

		expect(() =>
			markedOnDisk(branch, askedBy({ query: "flake" }), failing),
		).toThrow("a fault in the reader");
	});

	it("marks a second time only the entries whose calls pair oddly", () => {
		const path = log("reused-beside-plain.jsonl", [
			header("k"),
			user("k1", null, "the flake before the calls"),
			called("k2", "k1", "same", "bash", { command: "ls" }),
			called("k3", "k2", "same", "bash", { command: "ls -a" }),
			result("k4", "k3", "same", "the listing"),
			called("k5", "k4", "own", "bash", { command: "pwd" }),
			result("k6", "k5", "own", "the folder"),
			said("k7", "k6", "after"),
		]);
		const branch = [record("r", null, path, "k7"), said("a", "r", "now")];

		for (const request of [{ query: "listing" }, { query: "folder" }]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		// The two calls sharing an id, and not the one beside them.
		expect(markedOnDisk(branch, askedBy({ query: "flake" })).readAgain).toBe(2);
	});

	it("reads two calls given one id, and what follows them, as a whole read does", () => {
		const path = log("reused.jsonl", [
			header("u"),
			user("u1", null, "the flake before the reused id"),
			called("u2", "u1", "same", "bash", { command: "ls" }),
			called("u3", "u2", "same", "bash", { command: "ls -a" }),
			result("u4", "u3", "same", "the listing"),
			said("u5", "u4", "the flake after it"),
		]);
		const branch = [record("r", null, path, "u5"), said("a", "r", "now")];
		// Read a second time to pair its calls, it counts twice.
		expect(markedOnDisk(branch, askedBy({ query: "flake" })).bytes).toBe(
			2 * statSync(path).size,
		);

		for (const request of [
			{ query: "flake" },
			{ query: "listing" },
			{ entryId: "u2" },
			{ entryId: "u3" },
		]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		// A whole read gives both calls the one result.
		expect(hitIds(streamed(branch, { query: "listing" }))).toEqual([
			"u2",
			"u3",
		]);
		const disk = markedOnDisk(branch, askedBy({ query: "flake" }));
		expect(disk.marked.map((mark) => mark.id)).toEqual([
			"u1",
			"u2",
			"u3",
			"u4",
			"u5",
		]);
	});

	it("reads a call without the result that sits off its branch", () => {
		const path = log("forked.jsonl", [
			header("f"),
			user("f1", null, "the flake before the fork"),
			called("f2", "f1", "fc", "bash", { command: "ls" }),
			result("f3", "f2", "fc", "an orphaned listing"),
			said("f4", "f2", "a reply on another fork"),
		]);
		const branch = [record("r", null, path, "f4"), said("a", "r", "now")];

		for (const request of [
			{ query: "orphaned" },
			{ query: "flake" },
			{ entryId: "f2" },
		]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		expect(streamed(branch, { query: "orphaned" }).kind).toBe("none");
	});

	it("reads a result written before its call, and an id recall's own call shares, as a whole read does", () => {
		const path = log("odd.jsonl", [
			header("e"),
			user("e1", null, "the flake before the odd calls"),
			result("e2", "e1", "early", "an early listing"),
			called("e3", "e2", "early", "bash", { command: "ls" }),
			called("e4", "e3", "both", "session_recall", { query: "x" }),
			result("e5", "e4", "both", "[x] a hit"),
			called("e6", "e5", "both", "bash", { command: "cat secrets" }),
			result("e7", "e6", "both", "the secrets file"),
			said("e8", "e7", "done"),
		]);
		const branch = [record("r", null, path, "e8"), said("a", "r", "now")];

		for (const request of [
			{ query: "early listing" },
			{ query: "secrets" },
			{ entryId: "e3" },
			{ entryId: "e6" },
		]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		expect(hitIds(streamed(branch, { query: "early listing" }))).toEqual([
			"e3",
		]);
		expect(streamed(branch, { query: "secrets" }).kind).toBe("none");
	});

	it("reads a result rewritten as a plain message as a whole read does", () => {
		const path = log("unresulted.jsonl", [
			header("x"),
			user("x1", null, "the flake before the call"),
			called("x2", "x1", "xc", "bash", { command: "cat" }),
			result("x3", "x2", "xc", "an old listing"),
			said("x3", "x2", "no longer a result"),
			said("x4", "x3", "after"),
		]);
		const branch = [record("r", null, path, "x4"), said("a", "r", "now")];

		for (const request of [{ query: "listing" }, { entryId: "x2" }]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		expect(streamed(branch, { query: "listing" }).kind).toBe("none");
	});

	it("reads a call rewritten after its result as a whole read does", () => {
		const path = log("recalled.jsonl", [
			header("w"),
			user("w1", null, "the flake before the call"),
			called("w2", "w1", "wc", "bash", { command: "ls" }),
			result("w3", "w2", "wc", "the listing"),
			called("w2", "w1", "wc", "bash", { command: "ls -l" }),
			said("w4", "w3", "after"),
		]);
		const branch = [record("r", null, path, "w4"), said("a", "r", "now")];

		for (const request of [{ query: "listing" }, { entryId: "w2" }]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		expect(hitIds(streamed(branch, { query: "listing" }))).toEqual(["w2"]);
	});

	it("reads a call with the last of two results on its branch, as a whole read does", () => {
		const path = log("answered-twice.jsonl", [
			header("v"),
			user("v1", null, "the flake before the call"),
			called("v2", "v1", "vc", "bash", { command: "ls" }),
			result("v3", "v2", "vc", "the first listing"),
			result("v4", "v3", "vc", "the second listing"),
			said("v5", "v4", "after"),
		]);
		const branch = [record("r", null, path, "v5"), said("a", "r", "now")];

		for (const request of [
			{ query: "first" },
			{ query: "second" },
			{ entryId: "v2" },
		]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		expect(hitIds(streamed(branch, { query: "second" }))).toEqual(["v2"]);
		expect(streamed(branch, { query: "first" }).kind).toBe("none");
	});

	it("takes the last result in the branch's order, not the file's", () => {
		const path = log("out-of-order.jsonl", [
			header("o"),
			user("o1", null, "the flake before the call"),
			called("o2", "o1", "oc", "bash", { command: "ls" }),
			result("o4", "o3", "oc", "the later listing"),
			result("o3", "o2", "oc", "the earlier listing"),
			said("o5", "o4", "after"),
		]);
		const branch = [record("r", null, path, "o5"), said("a", "r", "now")];

		for (const request of [{ query: "later" }, { query: "earlier" }]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		expect(hitIds(streamed(branch, { query: "later" }))).toEqual(["o2"]);
		expect(streamed(branch, { query: "earlier" }).kind).toBe("none");
	});

	it("reads a call rewritten as recall's own, or from it, as a whole read does", () => {
		for (const [first, last, shown] of [
			["bash", "session_recall", false],
			["session_recall", "bash", true],
		] as const) {
			const path = log(`renamed-${first}.jsonl`, [
				header("q"),
				user("q1", null, "the flake before the call"),
				called("q2", "q1", "qc", first, { command: "ls" }),
				result("q3", "q2", "qc", "a renamed listing"),
				called("q2", "q1", "qc", last, { command: "ls" }),
				said("q4", "q3", "after"),
			]);
			const branch = [record("r", null, path, "q4"), said("a", "r", "now")];

			for (const request of [{ query: "renamed" }, { entryId: "q2" }]) {
				expect(streamed(branch, request)).toEqual(whole(branch, request));
			}
			expect(hitIds(streamed(branch, { query: "renamed" }))).toEqual(
				shown ? ["q2"] : [],
			);
		}
	});

	it("reads a paragraph reference to a call read again as a whole read does", () => {
		const speaking: Line = {
			type: "message",
			id: "t2",
			parentId: "t1",
			timestamp: at,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "the paragraph about a call given twice" },
					{ type: "toolCall", id: "tc", name: "bash", arguments: {} },
				],
				timestamp: 2,
			},
		};
		const path = log("named-twice.jsonl", [
			header("t"),
			user("t1", null, "the flake before the call"),
			speaking,
			result("t3", "t2", "tc", "the first listing"),
			called("t4", "t3", "tc", "bash", { command: "ls" }),
			result("t5", "t4", "tc", "the second listing"),
			said("t6", "t5", "after"),
		]);
		const branch = [record("r", null, path, "t6"), said("a", "r", "now")];
		const ref = paragraphRef(unitsOf(speaking as never)[0]?.hash ?? "");

		const found = streamed(branch, { entryId: ref });
		expect(found).toEqual(whole(branch, { entryId: ref }));
		expect(found.kind === "entry" && found.entry.text).toContain(
			"the second listing",
		);
	});

	it("reads a log again only for the calls a rewritten line makes or answers", () => {
		const path = log("rewritten-plain.jsonl", [
			header("z"),
			user("z1", null, "the flake before the call"),
			called("z2", "z1", "zc", "bash", { command: "ls" }),
			result("z3", "z2", "zc", "the listing"),
			said("z4", "z3", "a word said once"),
			said("z4", "z3", "a word said again"),
		]);
		const branch = [record("r", null, path, "z4"), said("a", "r", "now")];

		for (const request of [{ query: "listing" }, { query: "again" }]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		const disk = markedOnDisk(branch, askedBy({ query: "listing" }));
		expect(disk.bytes).toBe(statSync(path).size);
	});

	it("walks through lines pi never wrote, which say nothing", () => {
		const path = log("odd-lines.jsonl", [
			header("n"),
			user("n1", null, "the flake before the odd lines"),
			{ type: "message", id: "n2", parentId: "n1", timestamp: at },
			{ id: "n3", parentId: "n2" },
			{
				type: "message",
				id: "n4",
				parentId: "n3",
				timestamp: at,
				message: {
					role: "assistant",
					content: [null, { type: "text", text: "a flake beside a null" }],
				},
			},
			{ type: "compaction", id: "n5", parentId: "n4", summary: 7 },
			{
				type: "message",
				id: "n6",
				parentId: "n5",
				message: { role: "user", content: [null] },
			},
			{
				type: "message",
				id: "n6a",
				parentId: "n6",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "nc",
							name: { toString: 1 },
							arguments: {},
						},
					],
				},
			},
			{
				type: "message",
				id: "n6b",
				parentId: "n6a",
				message: {
					role: "bashExecution",
					command: { toString: 1 },
					output: { valueOf: 1 },
				},
			},
			{
				type: "message",
				id: "n6c",
				parentId: "n6b",
				message: {
					role: "assistant",
					content: [{ type: "text", text: { toString: 1 } }],
				},
			},
			said("n7", "n6c", "the flake after them"),
		]);
		const branch = [record("r", null, path, "n7"), said("a", "r", "now")];

		for (const request of [
			{ query: "flake" },
			{ entryId: "n3" },
			{ entryId: "p:ffffffffff" },
		]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		expect(hitIds(streamed(branch, { query: "flake" })).sort()).toEqual([
			"n1",
			"n4",
			"n7",
		]);
	});

	it("reads a call whose result never came, and what came before it", () => {
		const path = log("lost.jsonl", [
			header("l"),
			user("l1", null, "the flake before the lost call"),
			called("l2", "l1", "lost", "bash", { command: "grep flake" }),
			said("l3", "l2", "the answer after it"),
		]);
		const branch = [record("r", null, path, "l3"), said("a", "r", "now")];

		for (const request of [{ query: "flake" }, { entryId: "l2" }]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		expect(streamed(branch, { query: "flake" }).kind).toBe("hits");
		expect(streamed(branch, { entryId: "l1" }).kind).toBe("entry");
	});

	it("reads the last line given an id, as a whole read does", () => {
		const older = log("older.jsonl", [
			header("o"),
			said("o1", null, "a flake only the older log holds"),
		]);
		// d1 is rewritten, and d2 is first a record naming the older log,
		// then a plain message: the later line of each is what is read.
		const path = log("rewritten.jsonl", [
			header("d"),
			said("d1", null, "the first flake text"),
			record("d2", "d1", older, "o1"),
			said("d1", null, "the second flake text"),
			said("d2", "d1", "a flake in the rewritten line"),
		]);
		const branch = [record("r", null, path, "d2"), said("a", "r", "now")];

		for (const request of [
			{ query: "flake" },
			{ query: "first" },
			{ entryId: "d1" },
		]) {
			expect(streamed(branch, request)).toEqual(whole(branch, request));
		}
		expect(markedOnDisk(branch, askedBy({ query: "flake" })).logs).toBe(1);
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

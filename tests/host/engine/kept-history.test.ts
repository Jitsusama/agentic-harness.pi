/**
 * A hosted conversation opened from a compacted log holds only what a
 * rollover would keep, through pi's own session manager, while its file,
 * its id and everything that reads the whole log stay as they were.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	holdKeptHistory,
	holdsLikePi,
} from "../../../host/engine/kept-history.ts";
import { compactionHistory } from "../../../lib/compaction/history.ts";
import {
	askedBy,
	markEntries,
	answer as recallAnswer,
} from "../../../lib/internal/logs/recall.ts";
import { markedOnDisk } from "../../../lib/internal/logs/recall-on-disk.ts";
import {
	carriedBy,
	type Entry,
	messagesOnDisk,
	ROLLOVER_RECORD,
} from "../../../lib/internal/session/rollover.ts";
import {
	SPEND_CARRY,
	spentOnBranch,
} from "../../../lib/internal/spend/session-spend.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kept-history-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A user turn as pi records one. */
function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/** Which model answered a turn. */
interface Model {
	readonly provider: string;
	readonly model: string;
}

/** The model a test log's turns are answered by unless it says otherwise. */
const FAUX: Model = { provider: "faux", model: "faux-1" };

/** An answer as pi records one, costing `cost`. */
function answer(text: string, cost: number, by: Model = FAUX, input = 10) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-completions" as const,
		provider: by.provider,
		model: by.model,
		usage: {
			input,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** One exchange, its answer costing `cost`. */
function exchange(
	sessions: SessionManager,
	text: string,
	cost = 0.5,
	by: Model = FAUX,
	input?: number,
): void {
	sessions.appendMessage(user(text));
	sessions.appendMessage(answer(`answer to ${text}`, cost, by, input));
}

/** How a test log differs from the plain one. */
interface LogShape {
	/** Which entry of "kept one" the compaction keeps from. */
	readonly keepFrom?: "user" | "assistant";
	/** Whether the log was itself rolled over, its record carrying `other`. */
	readonly rolled?: boolean;
	/** Another model answering "early one". */
	readonly earlyBy?: Model;
	/** Whether an abandoned branch, costing 3, hangs off "early one". */
	readonly abandoned?: boolean;
	/** The prompt, in tokens, of the answer to "early one". */
	readonly earlyPrompt?: number;
	/**
	 * What comes right before "kept one": an extension's note, or an
	 * answer costing 0.25 that says "zephyr".
	 */
	readonly before?: "note" | "answer";
}

/**
 * A log of early turns and state, a compaction keeping the last two
 * turns, and a turn after it, written by pi; answers with its file.
 */
function compactedLog(shape: LogShape = {}): string {
	const sessions = SessionManager.create(dir, dir);
	if (shape.rolled)
		sessions.appendCustomEntry(ROLLOVER_RECORD, {
			parentSession: join(dir, "gone.jsonl"),
			parentLeaf: "00000000",
			dropped: 3,
			carried: { other: { kept: true }, [SPEND_CARRY]: { spend: 10 } },
		});
	sessions.appendModelChange("faux", "faux-1");
	sessions.appendThinkingLevelChange("high");
	exchange(sessions, "early one", 1, shape.earlyBy, shape.earlyPrompt);
	if (shape.abandoned) {
		const fork = sessions.getLeafId() ?? "";
		exchange(sessions, "abandoned", 3);
		sessions.branch(fork);
	}
	sessions.appendCustomEntry("away-state", { away: true });
	exchange(sessions, "early two", 2);
	if (shape.before === "answer")
		sessions.appendMessage(answer("zephyr has the last word", 0.25));
	else sessions.appendCustomMessageEntry("peers", "a note", false);
	exchange(sessions, "kept one");
	const kept = sessions
		.getBranch()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				entry.message.content === "kept one",
		);
	const keptAnswer = kept?.id
		? sessions.getBranch().find((entry) => entry.parentId === kept.id)
		: undefined;
	const from = shape.keepFrom === "assistant" ? keptAnswer : kept;
	exchange(sessions, "kept two");
	sessions.appendCompaction("what happened early", from?.id ?? "", 1000);
	exchange(sessions, "after");
	return fileOf(sessions);
}

/** The file pi writes `sessions` to. */
function fileOf(sessions: SessionManager): string {
	const file = sessions.getSessionFile();
	if (!file) throw new Error("pi named no file");
	return file;
}

/** The text of every message a manager holds. */
function texts(entries: readonly unknown[]): string[] {
	return entries.flatMap((entry) => {
		const e = entry as Partial<Entry> & { message?: { content?: unknown } };
		if (e.type !== "message") return [];
		const content = e.message?.content;
		if (typeof content === "string") return [content];
		return Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "")
			: [];
	});
}

/**
 * `file` opened by pi and held, failing here when the view did not go
 * in, so no test of what the view keeps passes on a whole open.
 */
function hold(file: string, report?: (said: unknown) => void): SessionManager {
	const held = holdKeptHistory(SessionManager.open(file), report);
	expect(texts(held.getEntries())).not.toContain("early one");
	expect(Object.hasOwn(held, "getTree")).toBe(true);
	return held;
}

/** The lines `file` gained since it read `before`, parsed. */
function linesAdded(file: string, before: string): Entry[] {
	const after = readFileSync(file, "utf8");
	expect(after.startsWith(before)).toBe(true);
	expect(after).not.toContain(ROLLOVER_RECORD);
	return after
		.slice(before.length)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Entry);
}

/** The entry of `entries` whose text is `text`. */
function entryAt<E>(entries: readonly E[], text: string): E {
	const found = entries.find((entry) => texts([entry]).includes(text));
	if (!found) throw new Error(`expected an entry reading ${text}`);
	return found;
}

/** What session_recall answers `request` with on `branch`, the log on disk read too. */
function recalled(
	branch: ReturnType<SessionManager["getBranch"]>,
	request: { readonly entryId?: string; readonly query?: string },
) {
	const asked = askedBy(request);
	const disk = markedOnDisk(branch, asked);
	return recallAnswer(
		[...disk.marked, ...markEntries(branch, asked)],
		request,
		asked,
	);
}

describe("a conversation held from a compacted log", () => {
	it("holds no message from before the kept entry", () => {
		const held = hold(compactedLog());
		expect(texts(held.getEntries())).toEqual([
			"kept one",
			"answer to kept one",
			"kept two",
			"answer to kept two",
			"after",
			"answer to after",
		]);
	});

	it("holds the state written before the kept entry", () => {
		const held = hold(compactedLog());
		const types = held.getEntries().map((entry) => entry.type);
		expect(types).toEqual(
			expect.arrayContaining([
				"model_change",
				"thinking_level_change",
				"custom",
			]),
		);
		expect(
			held
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom" && entry.customType === "away-state",
				),
		).toBe(true);
	});

	it("builds the same context the whole log builds", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file).buildSessionContext();
		expect(hold(file).buildSessionContext()).toEqual(whole);
	});

	it("keeps the session id, the file and its leaf", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file);
		const held = hold(file);
		expect(held.getSessionId()).toBe(whole.getSessionId());
		expect(held.getSessionFile()).toBe(file);
		expect(held.getLeafId()).toBe(whole.getLeafId());
	});

	it("appends after the true leaf and leaves every earlier line as it was", () => {
		const file = compactedLog();
		const before = readFileSync(file, "utf8");
		const held = hold(file);
		const leaf = held.getLeafId();
		exchange(held, "later");
		const added = linesAdded(file, before);
		expect(added).toHaveLength(2);
		expect(added[0]?.parentId).toBe(leaf);
	});

	it("comes back whole from disk after a new turn", () => {
		const file = compactedLog();
		exchange(hold(file), "later");
		const reopened = SessionManager.open(file);
		expect(texts(reopened.getEntries())).toContain("early one");
		expect(texts(reopened.getEntries())).toContain("later");
	});

	it("keeps the session's spend, turns left on disk included", () => {
		const file = compactedLog();
		const whole = spentOnBranch(SessionManager.open(file).getBranch());
		expect(spentOnBranch(hold(file).getBranch())).toBeCloseTo(whole);
		expect(whole).toBeCloseTo(4.5);
	});

	it("keeps the session's first prompt, its turn left on disk", () => {
		const file = compactedLog({ earlyPrompt: 40_000 });
		const whole = compactionHistory(SessionManager.open(file).getBranch());
		expect(whole.firstPromptTokens).toBe(40_000);
		expect(compactionHistory(hold(file).getBranch()).firstPromptTokens).toBe(
			40_000,
		);
	});

	it("lets a reader take back only the messages it asks for", () => {
		const file = compactedLog();
		const early = SessionManager.open(file)
			.getBranch()
			.filter((entry) => texts([entry]).some((text) => text.includes("early")))
			.map((entry) => entry.id);
		const answered = early[1];
		if (answered === undefined) throw new Error("no early answer");
		const read = messagesOnDisk(hold(file).getBranch(), new Set([answered]));
		expect(texts(read)).toEqual(["answer to early one"]);
	});

	it("lets session_recall read what it left on disk", () => {
		const file = compactedLog();
		const branch = hold(file).getBranch();
		const held = new Set(branch.map((entry) => entry.id));
		const left = SessionManager.open(file)
			.getBranch()
			.filter((entry) => !held.has(entry.id))
			.filter((entry) =>
				texts([entry]).some(
					(text) => text === "early one" || text === "answer to early two",
				),
			);
		expect(left).toHaveLength(2);
		for (const entry of left) {
			const found = recalled(branch, { entryId: entry.id });
			expect(found.kind === "entry" && found.entry).toEqual({
				id: entry.id,
				text: texts([entry]).join("\n"),
			});
		}
	});

	it.each<[string, LogShape, string]>([
		["an extension's note", {}, "note"],
		["an answer", { before: "answer" }, "zephyr"],
		[
			"an answer, the kept entry an answer too",
			{ before: "answer", keepFrom: "assistant" },
			"zephyr",
		],
	])(
		"reads the entry just before the kept turns as the whole log does, when it is %s",
		(_, shape, word) => {
			const file = compactedLog(shape);
			const whole = SessionManager.open(file).getBranch();
			const before = whole[whole.indexOf(entryAt(whole, "kept one")) - 1];
			if (!before) throw new Error("expected an entry before kept one");
			const report = vi.fn();
			const held = hold(file, report);
			// It hangs off the view's own chain, as the state kept does; a
			// branch to it reads the log back, so only its parent differs.
			expect(held.getEntry(before.id)).toEqual({
				...before,
				parentId: expect.any(String),
			});
			const byId = recalled(held.getBranch(), { entryId: before.id });
			expect(byId.kind).toBe("entry");
			expect(byId).toEqual(recalled(whole, { entryId: before.id }));
			const byWord = recalled(held.getBranch(), { query: word });
			const wholeWord = recalled(whole, { query: word });
			expect(
				byWord.kind === "hits" && byWord.hits.map((hit) => hit.id),
			).toEqual([before.id]);
			expect(
				wholeWord.kind === "hits" && wholeWord.hits.map((hit) => hit.id),
			).toEqual([before.id]);
			expect(report).not.toHaveBeenCalled();
		},
	);

	it("shows the whole tree", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file).getTree();
		expect(hold(file).getTree()).toEqual(whole);
	});

	it("branches to an entry it left on disk", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file);
		const early = whole
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			);
		if (!early) throw new Error("expected an early answer");
		const held = hold(file);
		held.branch(early.id);
		whole.branch(early.id);
		expect(held.getBranch()).toEqual(whole.getBranch());
	});

	it("forks the true branch", () => {
		const file = compactedLog();
		const expected = texts(SessionManager.open(file).getBranch());
		const held = hold(file);
		const forked = held.createBranchedSession(held.getLeafId() ?? "");
		if (!forked) throw new Error("expected a fork");
		expect(texts(SessionManager.open(forked).getBranch())).toEqual(expected);
	});
});

/** pi's own usage breakdown, the one its /session view reads, by model. */
type Breakdown = (
	entries: readonly unknown[],
) => { key: string; cost: number; tokens: number }[];

/** pi's own `getUsageCostBreakdown`, which its package does not export. */
async function pisBreakdown(): Promise<Breakdown> {
	const file = join(
		process.cwd(),
		"node_modules/@earendil-works/pi-coding-agent/dist/core/usage-totals.js",
	);
	const module = (await import(pathToFileURL(file).href)) as {
		getUsageCostBreakdown: Breakdown;
	};
	return module.getUsageCostBreakdown;
}

/** A breakdown as the test compares it: keys in order, costs rounded. */
function rounded(breakdown: ReturnType<Breakdown>) {
	return breakdown
		.map(({ key, cost, tokens }) => ({
			key,
			cost: Math.round(cost * 1e6),
			tokens,
		}))
		.sort((a, b) => a.key.localeCompare(b.key));
}

/** The entry of `manager`'s branch whose text is `text`. */
function entryReading(manager: SessionManager, text: string) {
	const found = manager
		.getBranch()
		.find((entry) => texts([entry]).includes(text));
	if (!found) throw new Error(`expected an entry reading ${text}`);
	return found;
}

describe("a held conversation and its whole log", () => {
	it("keeps pi's usage totals by model, other models and abandoned branches included", async () => {
		const breakdown = await pisBreakdown();
		const file = compactedLog({
			earlyBy: { provider: "other", model: "other-1" },
			abandoned: true,
		});
		const whole = breakdown(SessionManager.open(file).getEntries());
		const held = breakdown(hold(file).getEntries());
		expect(rounded(held)).toEqual(rounded(whole));
		expect(whole.map((entry) => entry.key).sort()).toEqual([
			"faux/faux-1",
			"other/other-1",
		]);
		const cost = whole.reduce((total, entry) => total + entry.cost, 0);
		expect(cost).toBeCloseTo(7.5);
	});

	it("keeps the spend when the kept entry is itself a costed answer", () => {
		const file = compactedLog({ keepFrom: "assistant" });
		const opened = SessionManager.open(file);
		const whole = spentOnBranch(opened.getBranch());
		const held = hold(file);
		// Its user message is held too, so a fork from it forks as pi's does;
		// the context still starts at the answer.
		expect(texts(held.getEntries())).toContain("kept one");
		expect(texts(held.getEntries())).not.toContain("early one");
		expect(held.buildSessionContext()).toEqual(opened.buildSessionContext());
		expect(spentOnBranch(held.getBranch())).toBeCloseTo(whole);
		expect(whole).toBeCloseTo(4.5);
	});

	it.each<[string, LogShape]>([
		["the kept entry a message", { before: "answer" }],
		["the kept entry an answer", { before: "answer", keepFrom: "assistant" }],
	])(
		"keeps the spend once when the entry before the kept turns is a costed answer, %s",
		(_, shape) => {
			const file = compactedLog(shape);
			const whole = spentOnBranch(SessionManager.open(file).getBranch());
			expect(spentOnBranch(hold(file).getBranch())).toBeCloseTo(whole);
			expect(whole).toBeCloseTo(4.75);
		},
	);

	it("keeps what an earlier rollover record carried", () => {
		const file = compactedLog({ rolled: true });
		const whole = SessionManager.open(file).getBranch();
		const held = hold(file);
		expect(carriedBy(held.getBranch(), "other")).toEqual({ kept: true });
		expect(spentOnBranch(held.getBranch())).toBeCloseTo(spentOnBranch(whole));
		expect(spentOnBranch(whole)).toBeCloseTo(14.5);
	});

	it("branches to a kept entry from before the compaction as the whole log does", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file);
		const target = entryReading(whole, "answer to kept two").id;
		const held = hold(file);
		held.branch(target);
		whole.branch(target);
		expect(held.getBranch()).toEqual(whole.getBranch());
		expect(held.buildSessionContext()).toEqual(whole.buildSessionContext());
	});

	it("branches from the compaction on without reading the log back", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file);
		const target = entryReading(whole, "after").id;
		const report = vi.fn();
		const held = hold(file, report);
		held.branch(target);
		whole.branch(target);
		expect(texts(held.getEntries())).not.toContain("early one");
		expect(held.buildSessionContext()).toEqual(whole.buildSessionContext());
		expect(report).not.toHaveBeenCalled();
	});

	it("looks up an entry it left on disk, and says it read the log back", () => {
		const file = compactedLog();
		const early = entryReading(SessionManager.open(file), "early one");
		const report = vi.fn();
		const held = hold(file, report);
		expect(held.getEntry(early.id)).toEqual(early);
		expect(report).toHaveBeenCalledWith(
			expect.stringContaining("whole log back into memory"),
		);
	});

	it("branches with a summary to an entry it left on disk", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file);
		const target = entryReading(whole, "answer to early one").id;
		const held = hold(file);
		held.branchWithSummary(target, "went back");
		whole.branchWithSummary(target, "went back");
		expect(texts(held.getBranch())).toEqual(texts(whole.getBranch()));
		expect(held.buildSessionContext().messages.length).toBe(
			whole.buildSessionContext().messages.length,
		);
	});

	it("keeps its leaf when it reads the whole log back", () => {
		const held = hold(compactedLog());
		const target = entryReading(held, "after").id;
		held.branch(target);
		held.getTree();
		expect(texts(held.getEntries())).toContain("early one");
		expect(held.getLeafId()).toBe(target);
	});

	it("keeps a reset leaf reset when it reads the whole log back", () => {
		const held = hold(compactedLog());
		held.resetLeaf();
		held.getTree();
		expect(texts(held.getEntries())).toContain("early one");
		expect(held.getLeafId()).toBeNull();
	});

	it("reads the log back once, even when its index was replaced", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file).getTree();
		const held = hold(file);
		const own = held as unknown as { byId: Map<string, unknown> };
		own.byId = new Map(own.byId);
		expect(held.getTree()).toEqual(whole);
		expect(Object.hasOwn(held, "getTree")).toBe(false);
	});

	it("writes the whole log when pi rewrites its file", () => {
		const file = compactedLog();
		const before = readFileSync(file, "utf8");
		const held = hold(file);
		(held as unknown as { _rewriteFile(): void })._rewriteFile();
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("lets go of the view when it switches to another log", () => {
		const other = SessionManager.create(dir, dir);
		exchange(other, "elsewhere");
		const held = hold(compactedLog());
		held.setSessionFile(fileOf(other));
		expect(texts(held.getEntries())).toEqual([
			"elsewhere",
			"answer to elsewhere",
		]);
		expect(Object.hasOwn(held, "getTree")).toBe(false);
	});

	it("lets go of the view when it starts a new session", () => {
		const held = hold(compactedLog());
		held.newSession();
		expect(held.getEntries()).toEqual([]);
		expect(Object.hasOwn(held, "getTree")).toBe(false);
		expect(Object.hasOwn(held, "getEntry")).toBe(false);
	});

	it("stays held and guarded when its log is gone", () => {
		const file = compactedLog();
		const held = hold(file);
		const id = held.getSessionId();
		rmSync(file);
		expect(() => held.getTree()).toThrow(/gone/);
		expect(held.getSessionId()).toBe(id);
		expect(texts(held.getEntries())).not.toContain("early one");
		expect(texts(held.getEntries())).toContain("after");
		expect(Object.hasOwn(held, "getTree")).toBe(true);
	});

	it("stays held, guarded and appending when its file now holds another conversation", () => {
		const file = compactedLog();
		const held = hold(file);
		const id = held.getSessionId();
		const leaf = held.getLeafId();
		const other = SessionManager.create(dir, dir);
		exchange(other, "elsewhere");
		const elsewhere = readFileSync(fileOf(other), "utf8");
		writeFileSync(file, elsewhere);
		expect(() => held.getTree()).toThrow(/now holds conversation/);
		expect(held.getSessionId()).toBe(id);
		expect(held.getSessionFile()).toBe(file);
		expect(held.getLeafId()).toBe(leaf);
		expect(texts(held.getEntries())).not.toContain("elsewhere");
		expect(Object.hasOwn(held, "getTree")).toBe(true);
		exchange(held, "later");
		const added = linesAdded(file, elsewhere);
		expect(added).toHaveLength(2);
		expect(added[0]?.parentId).toBe(leaf);
	});

	it("falls back to pi's whole open when the view fails to install", () => {
		const file = compactedLog();
		const opened = SessionManager.open(file);
		const own = opened as unknown as { _buildIndex(): void };
		const build = own._buildIndex.bind(opened);
		let failed = false;
		own._buildIndex = () => {
			if (!failed) {
				failed = true;
				throw new Error("index broke");
			}
			build();
		};
		const report = vi.fn();
		const held = holdKeptHistory(opened, report);
		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.stringMatching(
					new RegExp(
						`^Kept history couldn't hold conversation ${opened.getSessionId()}'s log, so it holds the whole log: index broke$`,
					),
				),
			}),
		);
		expect(texts(held.getEntries())).toContain("early one");
		expect(held.getLeafId()).toBe(SessionManager.open(file).getLeafId());
		expect(Object.hasOwn(held, "getTree")).toBe(false);
	});

	it("reads its log afresh, its leaf where it was, when its own entries fail to index again", () => {
		const file = compactedLog();
		const opened = SessionManager.open(file);
		const target = entryReading(opened, "after").id;
		opened.branch(target);
		const own = opened as unknown as { _buildIndex(): void };
		const build = own._buildIndex.bind(opened);
		let failures = 0;
		own._buildIndex = () => {
			if (failures < 2) {
				failures++;
				throw new Error(`index broke ${failures}`);
			}
			build();
		};
		const report = vi.fn();
		const held = holdKeptHistory(opened, report);
		expect(report.mock.calls.map(([said]) => String(said))).toEqual([
			expect.stringContaining("index broke 1"),
			expect.stringContaining("index broke 2"),
		]);
		expect(texts(held.getEntries())).toContain("early one");
		expect(held.getLeafId()).toBe(target);
		expect(held.getLeafId()).not.toBe(SessionManager.open(file).getLeafId());
		expect(Object.hasOwn(held, "getTree")).toBe(false);
	});

	it("leaves a manager already holding a view as it stands when held again", () => {
		const file = compactedLog();
		const held = hold(file);
		exchange(held, "later one");
		const kept = entryReading(held, "later one").id;
		exchange(held, "later two");
		held.appendCompaction("what happened since", kept, 1000);
		exchange(held, "latest");
		const entries = held.getEntries();
		const leaf = held.getLeafId();
		const report = vi.fn();
		expect(holdKeptHistory(held, report)).toBe(held);
		expect(held.getEntries()).toEqual(entries);
		expect(texts(held.getEntries())).toContain("after");
		expect(held.getLeafId()).toBe(leaf);
		expect(report).not.toHaveBeenCalled();
	});
});

describe("a conversation the view leaves whole", () => {
	it("holds everything when its log has no compaction", () => {
		const sessions = SessionManager.create(dir, dir);
		exchange(sessions, "one");
		exchange(sessions, "two");
		const held = holdKeptHistory(SessionManager.open(fileOf(sessions)));
		expect(texts(held.getEntries())).toEqual([
			"one",
			"answer to one",
			"two",
			"answer to two",
		]);
	});

	it("holds everything when it has no file", () => {
		const sessions = SessionManager.inMemory(dir);
		exchange(sessions, "early one");
		exchange(sessions, "kept one");
		const kept = entryReading(sessions, "kept one");
		sessions.appendCompaction("what happened early", kept.id, 1000);
		const held = holdKeptHistory(sessions);
		expect(texts(held.getEntries())).toContain("early one");
		expect(Object.hasOwn(held, "getTree")).toBe(false);
	});

	it("holds everything when a rollover record sits after the kept entry", () => {
		const sessions = SessionManager.create(dir, dir);
		exchange(sessions, "early one");
		exchange(sessions, "kept one");
		const kept = entryReading(sessions, "kept one");
		sessions.appendCustomEntry(ROLLOVER_RECORD, {
			parentSession: join(dir, "gone.jsonl"),
			parentLeaf: "00000000",
			dropped: 3,
			carried: { [SPEND_CARRY]: { spend: 10 } },
		});
		sessions.appendCompaction("what happened early", kept.id, 1000);
		exchange(sessions, "after");
		const held = holdKeptHistory(SessionManager.open(fileOf(sessions)));
		expect(texts(held.getEntries())).toContain("early one");
		expect(Object.hasOwn(held, "getTree")).toBe(false);
	});

	it("holds everything when its leaf is a label on an entry left on disk", () => {
		const file = compactedLog();
		const sessions = SessionManager.open(file);
		const early = entryReading(sessions, "early one");
		sessions.appendLabelChange(early.id, "start");
		const label = sessions.getLeafId();
		const before = readFileSync(file, "utf8");
		const held = holdKeptHistory(SessionManager.open(file));
		expect(texts(held.getEntries())).toContain("early one");
		exchange(held, "later");
		expect(linesAdded(file, before)[0]?.parentId).toBe(label);
	});
});

describe("a held conversation and pi's writes", () => {
	it("appends only its own lines when nothing kept was answered", () => {
		const sessions = SessionManager.create(dir, dir);
		exchange(sessions, "early one");
		sessions.appendMessage(user("kept one"));
		const kept = entryReading(sessions, "kept one");
		sessions.appendCompaction("what happened early", kept.id, 1000);
		const file = fileOf(sessions);
		const before = readFileSync(file, "utf8");
		const held = hold(file);
		held.appendCustomEntry("away-state", { away: false });
		held.appendMessage(answer("answer to kept one", 0.5));
		expect(linesAdded(file, before)).toHaveLength(2);
	});
});

describe("pi's session manager", () => {
	it("still has every private the view reaches into", () => {
		expect(holdsLikePi(SessionManager.inMemory(dir))).toBe(true);
	});

	it("writes its file only where the view knows it does", () => {
		// A method new to this list could write the view over the log: guard
		// it in kept-history.ts, or show it only appends once flushed.
		// `_persist` appends once flushed, which only `newSession` and
		// `createBranchedSession` undo, so its callers are not followed.
		const writes =
			/writeFileSync|appendFileSync|writeSync|openSync|fileEntries\s*=/;
		const proto = SessionManager.prototype as unknown as Record<
			string,
			unknown
		>;
		const sources = new Map(
			Object.getOwnPropertyNames(proto).flatMap((name) => {
				const method = Object.getOwnPropertyDescriptor(proto, name)?.value;
				return typeof method === "function"
					? [[name, String(method)] as const]
					: [];
			}),
		);
		const writers = new Set(
			[...sources].filter(([, source]) => writes.test(source)).map(([n]) => n),
		);
		let grew = true;
		while (grew) {
			grew = false;
			for (const [name, source] of sources) {
				if (writers.has(name)) continue;
				const reaches = [...writers].some(
					(writer) =>
						writer !== "_persist" &&
						writer !== "constructor" &&
						source.includes(`this.${writer}(`),
				);
				if (reaches) {
					writers.add(name);
					grew = true;
				}
			}
		}
		expect([...writers].sort()).toEqual(
			[
				"constructor",
				"_setSessionFile",
				"setSessionFile",
				"newSession",
				"_loadEntries",
				"_rewriteFile",
				"_persist",
				"createBranchedSession",
			].sort(),
		);
	});

	it("is said once when it no longer has what the view reads", async () => {
		vi.resetModules();
		const fresh = await import("../../../host/engine/kept-history.ts");
		const report = vi.fn();
		const unlike = { getSessionFile: () => "x" };
		expect(fresh.holdKeptHistory(unlike, report)).toBe(unlike);
		fresh.holdKeptHistory({}, report);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledWith(
			expect.stringContaining("Kept history is off"),
		);
	});
});

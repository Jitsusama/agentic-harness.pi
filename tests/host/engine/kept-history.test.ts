/**
 * A hosted conversation opened from a compacted log holds only what a
 * rollover would keep, through pi's own session manager, while its file,
 * its id and everything that reads the whole log stay as they were.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	holdKeptHistory,
	holdsLikePi,
} from "../../../host/engine/kept-history.ts";
import {
	ancestry,
	carriedBy,
	type Entry,
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

/** An answer as pi records one, costing `cost`. */
function answer(text: string, cost: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-completions" as const,
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** One exchange, its answer costing `cost`. */
function exchange(sessions: SessionManager, text: string, cost = 0.5): void {
	sessions.appendMessage(user(text));
	sessions.appendMessage(answer(`answer to ${text}`, cost));
}

/** How a test log differs from the plain one. */
interface LogShape {
	/** Which entry of "kept one" the compaction keeps from. */
	readonly keepFrom?: "user" | "assistant";
	/** Whether the log was itself rolled over, its record carrying `other`. */
	readonly rolled?: boolean;
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
	exchange(sessions, "early one", 1);
	sessions.appendCustomEntry("away-state", { away: true });
	exchange(sessions, "early two", 2);
	sessions.appendCustomMessageEntry("peers", "a note", false);
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

describe("a conversation held from a compacted log", () => {
	it("holds no message from before the kept entry", () => {
		const held = holdKeptHistory(SessionManager.open(compactedLog()));
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
		const held = holdKeptHistory(SessionManager.open(compactedLog()));
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
		const held = holdKeptHistory(SessionManager.open(file));
		expect(held.buildSessionContext()).toEqual(whole);
	});

	it("keeps the session id, the file and its leaf", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file);
		const held = holdKeptHistory(SessionManager.open(file));
		expect(held.getSessionId()).toBe(whole.getSessionId());
		expect(held.getSessionFile()).toBe(file);
		expect(held.getLeafId()).toBe(whole.getLeafId());
	});

	it("appends after the true leaf and leaves every earlier line as it was", () => {
		const file = compactedLog();
		const before = readFileSync(file, "utf8");
		const held = holdKeptHistory(SessionManager.open(file));
		const leaf = held.getLeafId();
		exchange(held, "later");
		const after = readFileSync(file, "utf8");
		expect(after.startsWith(before)).toBe(true);
		const added = after
			.slice(before.length)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Entry);
		expect(added[0]?.parentId).toBe(leaf);
		expect(after).not.toContain(ROLLOVER_RECORD);
	});

	it("comes back whole from disk after a new turn", () => {
		const file = compactedLog();
		const held = holdKeptHistory(SessionManager.open(file));
		exchange(held, "later");
		const reopened = SessionManager.open(file);
		expect(texts(reopened.getEntries())).toContain("early one");
		expect(texts(reopened.getEntries())).toContain("later");
	});

	it("keeps the session's spend, turns left on disk included", () => {
		const file = compactedLog();
		const whole = spentOnBranch(SessionManager.open(file).getBranch());
		const held = holdKeptHistory(SessionManager.open(file));
		expect(spentOnBranch(held.getBranch())).toBeCloseTo(whole);
		expect(whole).toBeCloseTo(4.5);
	});

	it("lets session_recall read what it left on disk", () => {
		const file = compactedLog();
		const held = holdKeptHistory(SessionManager.open(file));
		const branch = held.getBranch();
		const read = [...ancestry(branch), ...branch];
		expect(texts(read)).toEqual(
			expect.arrayContaining(["early one", "answer to early two", "after"]),
		);
	});

	it("shows the whole tree", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file).getTree();
		const held = holdKeptHistory(SessionManager.open(file));
		expect(held.getTree()).toEqual(whole);
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
		const held = holdKeptHistory(SessionManager.open(file));
		held.branch(early.id);
		whole.branch(early.id);
		expect(held.getBranch()).toEqual(whole.getBranch());
	});

	it("forks the true branch", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file);
		const expected = texts(whole.getBranch());
		const held = holdKeptHistory(SessionManager.open(file));
		const forked = held.createBranchedSession(held.getLeafId() ?? "");
		if (!forked) throw new Error("expected a fork");
		expect(texts(SessionManager.open(forked).getBranch())).toEqual(expected);
	});
});

/** The usage pi's footer and /session total over a manager's entries. */
function usageTotals(entries: readonly unknown[]) {
	const totals = { tokens: 0, cost: 0 };
	for (const entry of entries) {
		const e = entry as Record<string, unknown> & {
			message?: { role?: string; usage?: unknown };
		};
		const usage =
			e.type === "usage" ||
			e.type === "compaction" ||
			e.type === "branch_summary"
				? e.usage
				: e.type === "message"
					? e.message?.usage
					: undefined;
		if (typeof usage !== "object" || usage === null) continue;
		const u = usage as {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			cost: { total: number };
		};
		totals.tokens += u.input + u.output + u.cacheRead + u.cacheWrite;
		totals.cost += u.cost.total;
	}
	return totals;
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
	it("keeps the footer's usage totals, turns left on disk included", () => {
		const file = compactedLog();
		const whole = usageTotals(SessionManager.open(file).getEntries());
		const held = holdKeptHistory(SessionManager.open(file));
		expect(texts(held.getEntries())).not.toContain("early one");
		const kept = usageTotals(held.getEntries());
		expect(kept.tokens).toBe(whole.tokens);
		expect(kept.cost).toBeCloseTo(whole.cost);
		expect(whole.cost).toBeCloseTo(4.5);
	});

	it("keeps the spend when the kept entry is itself a costed answer", () => {
		const file = compactedLog({ keepFrom: "assistant" });
		const whole = spentOnBranch(SessionManager.open(file).getBranch());
		const held = holdKeptHistory(SessionManager.open(file));
		expect(texts(held.getEntries())).not.toContain("kept one");
		expect(spentOnBranch(held.getBranch())).toBeCloseTo(whole);
		expect(whole).toBeCloseTo(4.5);
	});

	it("keeps what an earlier rollover record carried", () => {
		const file = compactedLog({ rolled: true });
		const whole = SessionManager.open(file).getBranch();
		const held = holdKeptHistory(SessionManager.open(file));
		expect(texts(held.getEntries())).not.toContain("early one");
		expect(carriedBy(held.getBranch(), "other")).toEqual({ kept: true });
		expect(spentOnBranch(held.getBranch())).toBeCloseTo(spentOnBranch(whole));
		expect(spentOnBranch(whole)).toBeCloseTo(14.5);
	});

	it("branches to a kept entry from before the compaction as the whole log does", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file);
		const target = entryReading(whole, "answer to kept two").id;
		const held = holdKeptHistory(SessionManager.open(file));
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
		const held = holdKeptHistory(SessionManager.open(file), report);
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
		const held = holdKeptHistory(SessionManager.open(file), report);
		expect(texts(held.getEntries())).not.toContain("early one");
		expect(held.getEntry(early.id)).toEqual(early);
		expect(report).toHaveBeenCalledWith(
			expect.stringContaining("whole log back into memory"),
		);
	});

	it("branches with a summary to an entry it left on disk", () => {
		const file = compactedLog();
		const whole = SessionManager.open(file);
		const target = entryReading(whole, "answer to early one").id;
		const held = holdKeptHistory(SessionManager.open(file));
		held.branchWithSummary(target, "went back");
		whole.branchWithSummary(target, "went back");
		expect(texts(held.getBranch())).toEqual(texts(whole.getBranch()));
		expect(held.buildSessionContext().messages.length).toBe(
			whole.buildSessionContext().messages.length,
		);
	});

	it("keeps its leaf when it reads the whole log back", () => {
		const file = compactedLog();
		const held = holdKeptHistory(SessionManager.open(file));
		const target = entryReading(held, "after").id;
		held.branch(target);
		held.getTree();
		expect(texts(held.getEntries())).toContain("early one");
		expect(held.getLeafId()).toBe(target);
	});

	it("writes the whole log when pi rewrites its file", () => {
		const file = compactedLog();
		const before = readFileSync(file, "utf8");
		const held = holdKeptHistory(SessionManager.open(file));
		expect(texts(held.getEntries())).not.toContain("early one");
		(held as unknown as { _rewriteFile(): void })._rewriteFile();
		const after = readFileSync(file, "utf8");
		expect(after).toBe(before);
	});

	it("lets go of the view when it switches to another log", () => {
		const other = SessionManager.create(dir, dir);
		exchange(other, "elsewhere");
		const otherFile = other.getSessionFile() ?? "";
		const held = holdKeptHistory(SessionManager.open(compactedLog()));
		expect(Object.hasOwn(held, "getTree")).toBe(true);
		held.setSessionFile(otherFile);
		expect(texts(held.getEntries())).toEqual([
			"elsewhere",
			"answer to elsewhere",
		]);
		expect(Object.hasOwn(held, "getTree")).toBe(false);
	});

	it("lets go of the view when it starts a new session", () => {
		const held = holdKeptHistory(SessionManager.open(compactedLog()));
		held.newSession();
		expect(held.getEntries()).toEqual([]);
		expect(Object.hasOwn(held, "getTree")).toBe(false);
		expect(Object.hasOwn(held, "getEntry")).toBe(false);
	});

	it("stays held and guarded when its log can't be read back", () => {
		const file = compactedLog();
		const held = holdKeptHistory(SessionManager.open(file));
		const id = held.getSessionId();
		rmSync(file);
		expect(() => held.getTree()).toThrow(/gone/);
		expect(held.getSessionId()).toBe(id);
		expect(texts(held.getEntries())).not.toContain("early one");
		expect(texts(held.getEntries())).toContain("after");
		expect(Object.hasOwn(held, "getTree")).toBe(true);
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
		expect(report).toHaveBeenCalledWith(new Error("index broke"));
		expect(texts(held.getEntries())).toContain("early one");
		expect(held.getLeafId()).toBe(SessionManager.open(file).getLeafId());
		expect(Object.hasOwn(held, "getTree")).toBe(false);
	});
});

describe("a conversation the view leaves whole", () => {
	it("holds everything when its log has no compaction", () => {
		const sessions = SessionManager.create(dir, dir);
		exchange(sessions, "one");
		exchange(sessions, "two");
		const file = sessions.getSessionFile() ?? "";
		const held = holdKeptHistory(SessionManager.open(file));
		expect(texts(held.getEntries())).toEqual([
			"one",
			"answer to one",
			"two",
			"answer to two",
		]);
	});
});

describe("pi's session manager", () => {
	it("still has every private the view reaches into", () => {
		expect(holdsLikePi(SessionManager.inMemory(dir))).toBe(true);
	});

	it("writes its file only where the view knows it does", () => {
		// A method new to this list could write the view over the log: guard
		// it in kept-history.ts, or show it only appends once flushed.
		const writes =
			/writeFileSync|appendFileSync|writeSync|openSync|_rewriteFile\(|fileEntries\s*=/;
		const proto = SessionManager.prototype as unknown as Record<
			string,
			unknown
		>;
		const writers = Object.getOwnPropertyNames(proto).filter((name) => {
			const method = Object.getOwnPropertyDescriptor(proto, name)?.value;
			return typeof method === "function" && writes.test(method.toString());
		});
		expect(writers.sort()).toEqual(
			[
				"constructor",
				"_setSessionFile",
				"newSession",
				"_loadEntries",
				"_rewriteFile",
				"_persist",
				"createBranchedSession",
			].sort(),
		);
	});

	it("is said once when it no longer has what the view reads", () => {
		const report = vi.fn();
		const unlike = { getSessionFile: () => "x" };
		expect(holdKeptHistory(unlike, report)).toBe(unlike);
		holdKeptHistory({}, report);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledWith(
			expect.stringContaining("Kept history is off"),
		);
	});
});

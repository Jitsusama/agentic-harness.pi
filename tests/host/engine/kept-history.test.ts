/**
 * A hosted conversation opened from a compacted log holds only what a
 * rollover would keep, through pi's own session manager, while its file,
 * its id and everything that reads the whole log stay as they were.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	holdKeptHistory,
	holdsLikePi,
} from "../../../host/engine/kept-history.ts";
import {
	ancestry,
	type Entry,
	ROLLOVER_RECORD,
} from "../../../lib/internal/session/rollover.ts";
import { spentOnBranch } from "../../../lib/internal/spend/session-spend.ts";

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

/**
 * A log of early turns and state, a compaction keeping the last two
 * turns, and a turn after it, written by pi; answers with its file.
 */
function compactedLog(): string {
	const sessions = SessionManager.create(dir, dir);
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
	exchange(sessions, "kept two");
	sessions.appendCompaction("what happened early", kept?.id ?? "", 1000);
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
});

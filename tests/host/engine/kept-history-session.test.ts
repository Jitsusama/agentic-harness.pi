/**
 * A session whose log kept history holds in part counts and lists every
 * message of the log, as pi's own session does from a whole open.
 */

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdKeptHistory } from "../../../host/engine/kept-history.ts";
import { countLeftOut } from "../../../host/engine/kept-history-session.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kept-history-session-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A user turn as pi records one, its content in parts when asked. */
function user(text: string, parts = false) {
	return {
		role: "user" as const,
		content: parts ? [{ type: "text" as const, text }] : text,
		timestamp: Date.now(),
	};
}

/** An answer as pi records one, calling a tool when `call` names one. */
function answer(text: string, call?: string) {
	return {
		role: "assistant" as const,
		content: [
			{ type: "text" as const, text },
			...(call
				? [{ type: "toolCall" as const, id: call, name: "read", arguments: {} }]
				: []),
		],
		api: "openai-completions" as const,
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		},
		stopReason: call ? ("toolUse" as const) : ("stop" as const),
		timestamp: Date.now(),
	};
}

/** A tool's result as pi records one. */
function result(call: string) {
	return {
		role: "toolResult" as const,
		toolCallId: call,
		toolName: "read",
		content: [{ type: "text" as const, text: "read it" }],
		isError: false,
		timestamp: Date.now(),
	};
}

/** A user turn of text parts around an image, as a pasted screenshot is. */
function pasted(before: string, after: string) {
	return {
		role: "user" as const,
		content: [
			{ type: "text" as const, text: before },
			{ type: "image" as const, data: "aGk=", mimeType: "image/png" },
			{ type: "text" as const, text: after },
		],
		timestamp: Date.now(),
	};
}

/** A shell command the person ran, a message of neither side's turn. */
function shell() {
	return {
		role: "bashExecution" as const,
		command: "ls",
		output: "a",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	};
}

/** The id of the entry pi last appended to `sessions`. */
function last(sessions: SessionManager): string {
	const id = sessions.getLeafId();
	if (!id) throw new Error("expected an entry");
	return id;
}

/**
 * A log written by pi: early turns with a tool call, a user message of
 * parts, one of text around an image and one with no text, a shell
 * command, an abandoned branch, a compaction keeping the last two turns,
 * and a turn after it; answers with its file. With `aside`, a branch is
 * abandoned among the kept turns too, left out though the log holds it
 * after the first of them.
 */
function compactedLog(aside = false): string {
	const sessions = SessionManager.create(dir, dir);
	sessions.appendModelChange("faux", "faux-1");
	sessions.appendMessage(user("early one"));
	sessions.appendMessage(answer("reading", "call-1"));
	sessions.appendMessage(result("call-1"));
	sessions.appendMessage(answer("answer to early one"));
	const fork = last(sessions);
	sessions.appendMessage(user("abandoned"));
	sessions.appendMessage(answer("answer to abandoned"));
	sessions.branch(fork);
	sessions.appendMessage(user("early two in parts", true));
	sessions.appendMessage(answer("answer to early two"));
	sessions.appendMessage(user(""));
	sessions.appendMessage(answer("answer to nothing"));
	sessions.appendMessage(pasted("early ", "three"));
	sessions.appendMessage(answer("answer to early three"));
	sessions.appendMessage(shell());
	sessions.appendMessage(user("kept one"));
	const kept = last(sessions);
	sessions.appendMessage(answer("answer to kept one", "call-2"));
	sessions.appendMessage(result("call-2"));
	sessions.appendMessage(answer("done with kept one"));
	if (aside) {
		const back = last(sessions);
		sessions.appendMessage(user("aside"));
		sessions.appendMessage(answer("answer to aside"));
		sessions.branch(back);
	}
	sessions.appendMessage(user("kept two"));
	sessions.appendMessage(answer("answer to kept two"));
	sessions.appendCompaction("what happened early", kept, 1000);
	sessions.appendMessage(user("after"));
	sessions.appendMessage(answer("answer to after"));
	const file = sessions.getSessionFile();
	if (!file) throw new Error("pi named no file");
	return file;
}

/** pi's own session over `manager`, its methods as pi has them. */
function piSession(manager: SessionManager): AgentSession {
	const session = Object.create(AgentSession.prototype) as AgentSession;
	Object.assign(session, {
		sessionManager: manager,
		getContextUsage: () => undefined,
	});
	return session;
}

/** `file` opened by pi, held, and its session counting what it left out. */
function heldSession(
	file: string,
	report: (said: unknown) => void = () => {},
): AgentSession {
	const manager = holdKeptHistory(SessionManager.open(file));
	expect(Object.hasOwn(manager, "getTree")).toBe(true);
	const session = piSession(manager);
	countLeftOut(session, report);
	return session;
}

/** `file` opened whole by pi, as its session answers it. */
function wholeSession(file: string): AgentSession {
	return piSession(SessionManager.open(file));
}

/** The counts /session shows. */
function counts(session: AgentSession) {
	const { userMessages, assistantMessages, toolCalls, toolResults } =
		session.getSessionStats();
	const { totalMessages, tokens, cost } = session.getSessionStats();
	return {
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens,
		cost: Math.round(cost * 1e6),
	};
}

describe("a held session's /session counts", () => {
	it("count every message of the log, as the whole log does", () => {
		const file = compactedLog();
		const whole = counts(wholeSession(file));
		expect(whole.userMessages).toBe(8);
		expect(counts(heldSession(file))).toEqual(whole);
	});

	it("count each message once when the view is held again", () => {
		const file = compactedLog();
		const session = heldSession(file);
		holdKeptHistory(session.sessionManager);
		expect(counts(session)).toEqual(counts(wholeSession(file)));
	});

	it("count each message once when a new compaction comes between holds", () => {
		const file = compactedLog();
		const session = heldSession(file);
		compactAgain(session.sessionManager);
		holdKeptHistory(session.sessionManager);
		expect(saysUser(session.sessionManager, "after")).toBe(false);
		expect(counts(session)).toEqual(counts(wholeSession(file)));
	});

	it("keep counting what the log left after a read-back is refused", () => {
		const file = compactedLog();
		const whole = counts(wholeSession(file));
		const session = heldSession(file);
		copyFileSync(compactedLog(), file);
		expect(() => session.sessionManager.getTree()).toThrow(
			/now holds conversation/,
		);
		expect(counts(session)).toEqual(whole);
	});

	it("are pi's own once the whole log is read back", () => {
		const file = compactedLog();
		const session = heldSession(file);
		session.sessionManager.getTree();
		expect(counts(session)).toEqual(counts(wholeSession(file)));
	});

	it("leave a session holding its whole log as pi counts it", () => {
		const file = compactedLog();
		const session = wholeSession(file);
		const expected = counts(session);
		countLeftOut(session, () => {});
		expect(counts(session)).toEqual(expected);
	});

	it("leave a session without pi's counts as it is, said once", async () => {
		vi.resetModules();
		const fresh = await import("../../../host/engine/kept-history-session.ts");
		const report = vi.fn();
		const unlike = { sessionManager: {} };
		fresh.countLeftOut(unlike, report);
		fresh.countLeftOut({}, report);
		expect(unlike).toEqual({ sessionManager: {} });
		expect(report).toHaveBeenCalledTimes(1);
		expect(String(report.mock.calls[0]?.[0])).toContain("no longer has");
	});
});

describe("a held session's /fork list", () => {
	it("lists every user message of the log, in the whole log's order", () => {
		const file = compactedLog();
		const whole = wholeSession(file).getUserMessagesForForking();
		expect(whole.map((point) => point.text)).toEqual([
			"early one",
			"abandoned",
			"early two in parts",
			"early three",
			"kept one",
			"kept two",
			"after",
		]);
		expect(heldSession(file).getUserMessagesForForking()).toEqual(whole);
	});

	it("lists a branch abandoned among the kept turns where the log holds it", () => {
		const file = compactedLog(true);
		const whole = wholeSession(file).getUserMessagesForForking();
		expect(whole.map((point) => point.text).slice(-4)).toEqual([
			"kept one",
			"aside",
			"kept two",
			"after",
		]);
		const session = heldSession(file);
		expect(saysUser(session.sessionManager, "aside")).toBe(false);
		expect(session.getUserMessagesForForking()).toEqual(whole);
	});

	it("lists a message sent after the view was held", () => {
		const file = compactedLog();
		const session = heldSession(file);
		session.sessionManager.appendMessage(user("newest"));
		const texts = session
			.getUserMessagesForForking()
			.map((point) => point.text);
		expect(texts.slice(-2)).toEqual(["after", "newest"]);
		expect(texts).toContain("early one");
	});

	it("lists every user message once when a new compaction comes between holds", () => {
		const file = compactedLog();
		const session = heldSession(file);
		compactAgain(session.sessionManager);
		holdKeptHistory(session.sessionManager);
		expect(saysUser(session.sessionManager, "after")).toBe(false);
		expect(session.getUserMessagesForForking()).toEqual(
			wholeSession(file).getUserMessagesForForking(),
		);
	});

	it("forks from a message only the log holds, as pi's fork does", () => {
		const file = compactedLog();
		const session = heldSession(file);
		const early = session
			.getUserMessagesForForking()
			.find((point) => point.text === "early two in parts");
		if (!early) throw new Error("expected the early message listed");
		// pi's runtime fork: the entry by id, then its parent branched off a fresh open.
		const entry = session.sessionManager.getEntry(early.entryId);
		if (entry?.type !== "message") throw new Error("expected the message");
		const opened = SessionManager.open(file, dir);
		const forked = opened.createBranchedSession(entry.parentId ?? "");
		if (!forked) throw new Error("expected a fork");
		const branch = SessionManager.open(forked).getBranch();
		const said = branch.flatMap((e) =>
			e.type === "message" && e.message.role === "user"
				? [e.message.content]
				: [],
		);
		expect(said).toEqual(["early one"]);
	});

	it("lists every user message without reading the log again", () => {
		const file = compactedLog();
		const whole = wholeSession(file).getUserMessagesForForking();
		const report = vi.fn();
		const session = heldSession(file, report);
		rmSync(file);
		expect(session.getUserMessagesForForking()).toEqual(whole);
		expect(report).not.toHaveBeenCalled();
	});
});

/**
 * Talk on in a held session past a second compaction, which keeps from
 * the second of two new turns, and a turn after it.
 */
function compactAgain(manager: SessionManager): void {
	manager.appendMessage(user("later one"));
	manager.appendMessage(answer("answer to later one"));
	manager.appendMessage(user("later two"));
	const kept = last(manager);
	manager.appendMessage(answer("answer to later two"));
	manager.appendCompaction("what happened since", kept, 1000);
	manager.appendMessage(user("latest"));
	manager.appendMessage(answer("answer to latest"));
}

/** Whether `manager` holds a user message saying `text`. */
function saysUser(manager: SessionManager, text: string): boolean {
	return manager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				entry.message.content === text,
		);
}

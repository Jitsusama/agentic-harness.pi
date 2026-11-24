/**
 * A session whose log kept history holds in part counts and lists every
 * message of the log, as pi's own session does from a whole open.
 */

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentSession,
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeResult,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
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

/** How a test log differs from the usual one. */
interface Shape {
	/** A branch abandoned among the kept turns, after the first of them. */
	readonly aside?: boolean;
	/** The compaction keeps from the answer to the first kept message. */
	readonly keepAnswer?: boolean;
	/** A model change, which the view keeps, right before "kept one". */
	readonly stateBefore?: boolean;
	/** After the compaction, this pointing at the first message, then "after". */
	readonly pointAtEarly?: "label" | "context_edit";
	/** A user message, "just before", sent right before "kept one". */
	readonly twoInARow?: boolean;
	/** After the compaction, a label marking "kept one". */
	readonly labelKept?: boolean;
}

/**
 * A log written by pi: early turns with a tool call, a user message of
 * parts, one of text around an image, one with no text and one of only
 * spaces, an extension's message, a shell command, a branch abandoned
 * with a paid summary, a compaction keeping the last two turns, and a
 * turn after it; answers with its file, shaped as `shape` says.
 */
function compactedLog(shape: Shape = {}): string {
	const sessions = SessionManager.create(dir, dir);
	sessions.appendModelChange("faux", "faux-1");
	const early = sessions.appendMessage(user("early one"));
	sessions.appendMessage(answer("reading", "call-1"));
	sessions.appendMessage(result("call-1"));
	sessions.appendMessage(answer("answer to early one"));
	const fork = last(sessions);
	sessions.appendMessage(user("abandoned"));
	sessions.appendMessage(answer("answer to abandoned"));
	sessions.branchWithSummary(
		fork,
		"left abandoned",
		undefined,
		false,
		answer("summary").usage,
	);
	sessions.appendMessage(user("early two in parts", true));
	sessions.appendMessage(answer("answer to early two"));
	sessions.appendMessage(user(""));
	sessions.appendMessage(answer("answer to nothing"));
	sessions.appendMessage(user("  "));
	sessions.appendMessage(answer("answer to spaces"));
	sessions.appendCustomMessageEntry("note", "an extension speaks", true);
	sessions.appendMessage(pasted("early ", "three"));
	sessions.appendMessage(answer("answer to early three"));
	sessions.appendMessage(shell());
	if (shape.stateBefore) sessions.appendModelChange("faux", "faux-2");
	if (shape.twoInARow) sessions.appendMessage(user("just before"));
	const keptOne = sessions.appendMessage(user("kept one"));
	const answered = sessions.appendMessage(
		answer("answer to kept one", "call-2"),
	);
	const kept = shape.keepAnswer ? answered : keptOne;
	sessions.appendMessage(result("call-2"));
	sessions.appendMessage(answer("done with kept one"));
	if (shape.aside) {
		const back = last(sessions);
		sessions.appendMessage(user("aside"));
		sessions.appendMessage(answer("answer to aside"));
		sessions.branch(back);
	}
	sessions.appendMessage(user("kept two"));
	sessions.appendMessage(answer("answer to kept two"));
	sessions.appendCompaction("what happened early", kept, 1000);
	if (shape.pointAtEarly === "label")
		sessions.appendLabelChange(early, "start");
	if (shape.pointAtEarly === "context_edit")
		sessions.appendContextEdit(early, null);
	if (shape.labelKept) sessions.appendLabelChange(keptOne, "pinned");
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
	const manager = holdKeptHistory(SessionManager.open(file), report);
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
		expect(whole.userMessages).toBe(9);
		expect(counts(heldSession(file))).toEqual(whole);
	});

	it("count each message once when a new compaction comes before the view is held again", () => {
		const file = compactedLog();
		const session = heldSession(file);
		compactAgain(session.sessionManager);
		holdKeptHistory(session.sessionManager);
		expect(saysUser(session.sessionManager, "after")).toBe(true);
		expect(counts(session)).toEqual(counts(wholeSession(file)));
		expect(session.getUserMessagesForForking()).toEqual(
			wholeSession(file).getUserMessagesForForking(),
		);
	});

	it("keep counting what the log left after a read-back is refused", () => {
		const file = compactedLog();
		const whole = counts(wholeSession(file));
		const session = heldSession(file);
		// Another conversation's log with more messages, so any of it counted shows.
		const other = compactedLog({ aside: true });
		expect(counts(wholeSession(other))).not.toEqual(whole);
		copyFileSync(other, file);
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
			"  ",
			"early three",
			"kept one",
			"kept two",
			"after",
		]);
		expect(heldSession(file).getUserMessagesForForking()).toEqual(whole);
	});

	it("lists every user message once the whole log is read back", () => {
		const file = compactedLog();
		const session = heldSession(file);
		session.sessionManager.getTree();
		expect(Object.hasOwn(session.sessionManager, "getTree")).toBe(false);
		expect(session.getUserMessagesForForking()).toEqual(
			wholeSession(file).getUserMessagesForForking(),
		);
		// A branch into a new file leaves the abandoned message behind, which
		// what the view took would still list.
		const leaf = session.sessionManager.getLeafId();
		if (!leaf) throw new Error("the log has no leaf");
		const branched = session.sessionManager.createBranchedSession(leaf);
		if (!branched) throw new Error("pi wrote no branched log");
		const listed = session.getUserMessagesForForking();
		expect(listed.map((point) => point.text)).not.toContain("abandoned");
		expect(listed).toEqual(wholeSession(branched).getUserMessagesForForking());
	});

	it("lists every user message the log held after a read-back is refused", () => {
		const file = compactedLog();
		const whole = wholeSession(file).getUserMessagesForForking();
		const session = heldSession(file);
		// Another conversation's log with more messages, so any of it listed shows.
		const other = compactedLog({ aside: true });
		expect(wholeSession(other).getUserMessagesForForking()).not.toEqual(whole);
		copyFileSync(other, file);
		expect(() => session.sessionManager.getTree()).toThrow(
			/now holds conversation/,
		);
		expect(session.getUserMessagesForForking()).toEqual(whole);
	});

	it("lists a branch abandoned among the kept turns where the log holds it", () => {
		const file = compactedLog({ aside: true });
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
		session.sessionManager.appendMessage(answer("answer to newest"));
		const whole = wholeSession(file).getUserMessagesForForking();
		expect(whole.map((point) => point.text).slice(-2)).toEqual([
			"after",
			"newest",
		]);
		expect(session.getUserMessagesForForking()).toEqual(whole);
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

describe("a held session's /fork, through pi's own", () => {
	it.each<[string, Shape, string, number]>([
		["a message only the log holds", {}, "early two in parts", 1],
		["the first kept message", {}, "kept one", 0],
		["a kept message after it", {}, "kept two", 0],
		[
			"a message just before the first kept entry",
			{ keepAnswer: true },
			"kept one",
			0,
		],
		[
			"the first of two messages just before the first kept entry",
			{ keepAnswer: true, twoInARow: true },
			"just before",
			0,
		],
		[
			"the second of two messages just before the first kept entry",
			{ keepAnswer: true, twoInARow: true },
			"kept one",
			0,
		],
		[
			"the first kept message, after state the view keeps",
			{ stateBefore: true },
			"kept one",
			0,
		],
		[
			"a message just before the first kept entry, after state the view keeps",
			{ keepAnswer: true, stateBefore: true },
			"kept one",
			0,
		],
		[
			"a kept message after a labelled one before the first kept entry",
			{ keepAnswer: true, labelKept: true },
			"kept two",
			0,
		],
		[
			"a message after a label on an entry left out",
			{ pointAtEarly: "label" },
			"after",
			0,
		],
	])(
		"forks from %s as from the whole log",
		async (_, shape, text, readsBack) => {
			const file = compactedLog(shape);
			const whole = wholeSession(file);
			const at = whole
				.getUserMessagesForForking()
				.find((point) => point.text === text)?.entryId;
			if (!at) throw new Error(`expected ${text} listed`);
			const expected = await forkOf(whole, at);
			const report = vi.fn();
			const held = heldSession(file, report);
			expect(await forkOf(held, at)).toEqual(expected);
			const said = report.mock.calls.map(([what]) => String(what));
			expect(said).toHaveLength(readsBack);
			for (const what of said) expect(what).toContain("whole log back");
		},
	);

	it("forks from a message after an edit of an entry left out as from the whole log, said held whole", async () => {
		const file = compactedLog({ pointAtEarly: "context_edit" });
		const whole = wholeSession(file);
		const at = whole
			.getUserMessagesForForking()
			.find((point) => point.text === "after")?.entryId;
		if (!at) throw new Error("expected after listed");
		const expected = await forkOf(whole, at);
		const report = vi.fn();
		const manager = holdKeptHistory(SessionManager.open(file), report);
		expect(Object.hasOwn(manager, "getTree")).toBe(false);
		const said = report.mock.calls.map(([what]) => String(what));
		expect(said).toEqual([
			expect.stringMatching(
				/holds the whole log: a context_edit entry it would leave out sits before kept message/,
			),
		]);
		const held = piSession(manager);
		countLeftOut(held, () => {});
		expect(await forkOf(held, at)).toEqual(expected);
	});

	it("keeps a label on a message held before the first kept entry", () => {
		const file = compactedLog({ keepAnswer: true, labelKept: true });
		const whole = wholeSession(file);
		const keptOne = whole
			.getUserMessagesForForking()
			.find((point) => point.text === "kept one")?.entryId;
		if (!keptOne) throw new Error("expected kept one listed");
		expect(whole.sessionManager.getLabel(keptOne)).toBe("pinned");
		const held = heldSession(file).sessionManager;
		expect(held.getLabel(keptOne)).toBe("pinned");
	});
});

/**
 * What pi's own runtime fork from `entryId` makes of `session`: the new
 * log's branch, its labels by what they mark, and the text handed back.
 */
async function forkOf(session: AgentSession, entryId: string) {
	Object.assign(session, {
		_extensionRunner: { hasHandlers: () => false },
		abort: async () => {},
		dispose: () => {},
	});
	const services = { cwd: dir, agentDir: dir } as AgentSessionServices;
	let forked: SessionManager | undefined;
	const runtime = new AgentSessionRuntime(
		session,
		services,
		async ({ sessionManager }) => {
			forked = sessionManager;
			return {
				session: piSession(sessionManager),
				services,
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		},
	);
	const { selectedText } = await runtime.fork(entryId);
	if (!forked) throw new Error("pi forked nothing");
	return {
		selectedText,
		branch: forked
			.getBranch()
			.map((entry) =>
				entry.type === "label"
					? { type: entry.type, targetId: entry.targetId, label: entry.label }
					: { type: entry.type, id: entry.id, parentId: entry.parentId },
			),
	};
}

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

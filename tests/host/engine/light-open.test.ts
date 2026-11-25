/**
 * A hosted conversation's log opened light holds what pi's own open and
 * the kept view hold, and what the view leaves out is never held whole,
 * while pi's own open stands wherever the light one can't match it.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStanding } from "../../../host/engine/gone-folder.ts";
import {
	holdKeptHistory,
	leftOutOf,
} from "../../../host/engine/kept-history.ts";
import {
	type LightPi,
	openKept,
	readLight,
} from "../../../host/engine/light-open.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import type { Entry } from "../../../lib/internal/session/rollover.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "light-open-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** The usage pi records for a turn costing `cost`. */
function usage(cost: number) {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

/** An answer as pi records one, holding `content`. */
function answer(content: unknown[], cost: number) {
	return {
		role: "assistant" as const,
		content,
		api: "openai-completions" as const,
		provider: "faux",
		model: "faux-1",
		usage: usage(cost),
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/**
 * A turn that calls a tool: the question, an answer that thinks and
 * calls, the tool's result with its details, and the last answer. Each
 * text holds characters of two to four bytes, so a small read splits them.
 */
function toolTurn(sessions: SessionManager, text: string, cost = 0.5): void {
	sessions.appendMessage({
		role: "user",
		content: `${text} é✓🙂`,
		timestamp: Date.now(),
	});
	const call = `call-${text.replace(/ /g, "-")}`;
	sessions.appendMessage(
		answer(
			[
				{ type: "thinking", thinking: `pondering ${text} ✓`, signature: "s" },
				{ type: "toolCall", id: call, name: "bash", arguments: { c: "ls" } },
			],
			cost,
		) as never,
	);
	sessions.appendMessage({
		role: "toolResult",
		toolCallId: call,
		toolName: "bash",
		content: [{ type: "text", text: `output of ${text} 🙂`.repeat(20) }],
		details: { full: `everything ${text} printed é`.repeat(20) },
		isError: false,
		timestamp: Date.now(),
	} as never);
	sessions.appendMessage(
		answer([{ type: "text", text: `answer to ${text} é` }], cost) as never,
	);
}

/** The id of the user message on the branch whose text starts `text`. */
function userId(sessions: SessionManager, text: string): string {
	const entry = sessions
		.getBranch()
		.find(
			(e) =>
				e.type === "message" &&
				e.message.role === "user" &&
				typeof e.message.content === "string" &&
				e.message.content.startsWith(text),
		);
	if (!entry) throw new Error(`no user message ${text}`);
	return entry.id;
}

/**
 * A log written by pi with every kind of entry the light read drops
 * values from, two compactions, an abandoned branch and state, the last
 * compaction keeping from "kept one"; answers with its file.
 */
function compactedLog(cwd: string = dir): string {
	const sessions = SessionManager.create(cwd, dir);
	sessions.appendModelChange("faux", "faux-1");
	sessions.appendThinkingLevelChange("high");
	toolTurn(sessions, "early one", 1);
	const note = "a long note é".repeat(30);
	sessions.appendCustomMessageEntry("peers", note, false, { by: "a peer ✓" });
	sessions.appendCompaction(
		"the first summary é",
		userId(sessions, "early one"),
		900,
	);
	const fork = sessions.getLeafId() ?? "";
	toolTurn(sessions, "abandoned", 3);
	sessions.branchWithSummary(fork, "what the abandoned branch did ✓");
	sessions.appendCustomEntry("away-state", { away: true });
	toolTurn(sessions, "early two", 2);
	toolTurn(sessions, "kept one");
	sessions.appendCompaction(
		"the last summary 🙂",
		userId(sessions, "kept one"),
		1000,
	);
	toolTurn(sessions, "after");
	const file = sessions.getSessionFile();
	if (!file) throw new Error("pi named no file");
	return file;
}

/** The ids `file` holds, so the view's own ids can be told apart. */
function idsOf(file: string): Set<string> {
	const ids = new Set<string>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		try {
			const id: unknown = JSON.parse(line).id;
			if (typeof id === "string") ids.add(id);
		} catch {
			// A line that isn't JSON holds no id.
		}
	}
	return ids;
}

/**
 * What a held manager answers, its view's own random ids named by the
 * order they first appear, so two holds of one log compare equal.
 */
function answers(manager: SessionManager, file: string): unknown {
	const ids = idsOf(file);
	const named = new Map<string, string>();
	const text = JSON.stringify({
		header: manager.getHeader(),
		entries: manager.getEntries(),
		leaf: manager.getLeafId(),
		context: manager.buildSessionContext(),
		left: leftOutOf(manager),
		id: manager.getSessionId(),
		cwd: manager.getCwd(),
		file: manager.getSessionFile(),
		dir: manager.getSessionDir(),
	});
	return JSON.parse(
		text.replace(/"([0-9a-f]{8})"/g, (whole, id: string) => {
			if (ids.has(id)) return whole;
			if (!named.has(id)) named.set(id, `view-${named.size}`);
			return `"${named.get(id)}"`;
		}),
	);
}

/** pi's own open of `file`, held as the engine holds it. */
function piHeld(file: string): SessionManager {
	const held = holdKeptHistory(SessionManager.open(file));
	expect(leftOutOf(held)).toBeDefined();
	return held;
}

/** pi's session layer as the engine hands it to the light open. */
const PI: LightPi = { SessionManager, version: CURRENT_SESSION_VERSION };

/** The light open of `file` as the engine makes it, failing when it fell back. */
function lightHeld(file: string): SessionManager {
	const opened = openKept(PI, file);
	if (!opened) throw new Error("the light open fell back to pi's");
	const { manager } = opened;
	if (!(manager instanceof SessionManager))
		throw new Error("the light open built another kind of manager");
	return manager;
}

/** The parsed lines of `file`. */
function lines(file: string): unknown[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

describe("a log opened light", () => {
	it("holds what pi's open holds once it holds the kept view", () => {
		const file = compactedLog();
		const before = readFileSync(file, "utf8");
		expect(answers(lightHeld(file), file)).toEqual(answers(piHeld(file), file));
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("skips blank and malformed lines as pi's open does", () => {
		const file = compactedLog();
		const text = readFileSync(file, "utf8").split("\n");
		text.splice(5, 0, "", "{not json", "   ", "null");
		writeFileSync(file, text.join("\n"));
		expect(answers(lightHeld(file), file)).toEqual(answers(piHeld(file), file));
	});

	it("adds only its next entry to the log, off the leaf it opened on", () => {
		const file = compactedLog();
		const before = readFileSync(file, "utf8");
		const light = lightHeld(file);
		const leaf = light.getLeafId();
		light.appendCustomEntry("note", { n: 1 });
		const after = readFileSync(file, "utf8");
		expect(after.startsWith(before)).toBe(true);
		const added = after.slice(before.length).trim().split("\n");
		expect(added.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({ customType: "note", parentId: leaf }),
		]);
	});

	it("opens in the folder that stands when its own is gone, as pi's does", () => {
		const gone = join(dir, "tree", "gone");
		mkdirSync(gone, { recursive: true });
		const file = compactedLog(gone);
		rmSync(join(dir, "tree"), { recursive: true });
		const light = openKept(PI, file, () => {}, dir);
		const standing = openStanding(SessionManager, file, dir);
		expect(light?.left).toBe(standing.left);
		expect(light?.left).toBe(gone);
		expect(light?.manager.getCwd()).toBe(standing.manager.getCwd());
		expect(light?.manager.getCwd()).toBe(dir);
	});
});

describe("a light read", () => {
	it("drops the values only a held entry needs, keeping what the view reads", () => {
		const file = compactedLog();
		const read = readLight(file);
		if (!read) throw new Error("no light read");
		const records = read.entries.filter(isRecord);
		const said = (role: string) =>
			records.flatMap(({ message }) =>
				isRecord(message) && message.role === role ? [message] : [],
			);
		const typed = (type: string) =>
			records.filter((entry) => entry.type === type);
		expect(said("assistant").length).toBeGreaterThan(0);
		for (const message of said("assistant")) {
			expect(message).toMatchObject({ provider: "faux", model: "faux-1" });
			expect(message.usage).toMatchObject({ input: 10, output: 10 });
			expect(message.content).toBeInstanceOf(Array);
			for (const part of [message.content].flat())
				expect(isRecord(part) && Object.keys(part)).toEqual(["type"]);
		}
		expect(said("assistant").map(({ content }) => content)).toContainEqual([
			{ type: "thinking" },
			{ type: "toolCall" },
		]);
		expect(said("toolResult").length).toBeGreaterThan(0);
		for (const message of said("toolResult")) {
			expect(message.content).toEqual([]);
			expect(message).not.toHaveProperty("details");
		}
		const users = said("user").map(({ content }) => content);
		expect(users).toContain("early one é✓🙂");
		const summaries = [...typed("compaction"), ...typed("branch_summary")];
		expect(summaries.map(({ summary }) => summary)).toEqual(["", "", ""]);
		expect(typed("custom_message")).toEqual([
			expect.not.objectContaining({ details: expect.anything() }),
		]);
		expect(typed("custom_message").map(({ content }) => content)).toEqual([""]);
		expect(typed("custom")).toContainEqual(
			expect.objectContaining({ data: { away: true } }),
		);
	});

	it("reads every entry back whole from its line, at any read size", () => {
		const file = compactedLog();
		for (const size of [1, 7, 4096]) {
			const read = readLight(file, size);
			if (!read) throw new Error("no light read");
			expect(read.whole(read.entries as Entry[])).toEqual(lines(file));
		}
	});

	it("refuses to read back a line that no longer parses", () => {
		const file = compactedLog();
		const read = readLight(file);
		if (!read) throw new Error("no light read");
		const text = readFileSync(file, "utf8");
		writeFileSync(file, `${text.slice(0, 200)}${text.slice(210)}`);
		expect(() => read.whole(read.entries as Entry[])).toThrow(
			/no longer holds/,
		);
	});

	it("refuses to read back a line that now holds another entry", () => {
		const file = compactedLog();
		const read = readLight(file);
		if (!read) throw new Error("no light read");
		const text = readFileSync(file, "utf8");
		const at = text.indexOf('"role":"toolResult"');
		const line = text.lastIndexOf("\n", at) + 1;
		const id = text.indexOf('"id":"', line) + '"id":"'.length;
		writeFileSync(file, `${text.slice(0, id)}ffffffff${text.slice(id + 8)}`);
		expect(() => read.whole(read.entries as Entry[])).toThrow(
			/no longer holds/,
		);
	});
});

describe("pi's own open stands", () => {
	/** Whether the light open of `file` fell back, `file` left as it was. */
	function fallsBack(file: string, pi: LightPi = PI): boolean {
		const before = readFileSync(file, "utf8");
		const opened = openKept(pi, file);
		expect(readFileSync(file, "utf8")).toBe(before);
		return opened === undefined;
	}

	it("for a log the view would hold whole", () => {
		const sessions = SessionManager.create(dir, dir);
		toolTurn(sessions, "only");
		expect(fallsBack(sessions.getSessionFile() ?? "")).toBe(true);
	});

	it("for a log pi would migrate, which pi writes back whole", () => {
		const file = compactedLog();
		const text = readFileSync(file, "utf8");
		writeFileSync(
			file,
			text.replace(`"version":${CURRENT_SESSION_VERSION}`, '"version":2'),
		);
		expect(fallsBack(file)).toBe(true);
	});

	it("for a pi that doesn't say its log version", () => {
		const pi = { SessionManager, version: undefined };
		expect(fallsBack(compactedLog(), pi)).toBe(true);
	});

	it("for a log whose last line is unfinished, which pi ends itself", () => {
		const file = compactedLog();
		writeFileSync(file, `${readFileSync(file, "utf8")}{"type":"cus`);
		expect(fallsBack(file)).toBe(true);
	});

	it("for a file that isn't a log", () => {
		const file = join(dir, "not-a-log.jsonl");
		writeFileSync(file, '{"type":"message","id":"x"}\n');
		expect(fallsBack(file)).toBe(true);
	});

	it("for a pi whose session manager no longer takes entries as this expects", () => {
		class Other {}
		const pi = { SessionManager: Other, version: CURRENT_SESSION_VERSION };
		expect(fallsBack(compactedLog(), pi)).toBe(true);
	});

	it("for a session manager that reads the log itself rather than take its entries", () => {
		// biome-ignore lint/complexity/useArrowFunction: the open constructs it, which an arrow refuses.
		const reads = function (...args: unknown[]) {
			return SessionManager.open(String(args[2]));
		};
		const pi = { SessionManager: reads, version: CURRENT_SESSION_VERSION };
		expect(fallsBack(compactedLog(), pi)).toBe(true);
	});
});

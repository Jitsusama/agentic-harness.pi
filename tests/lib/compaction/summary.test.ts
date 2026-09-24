import { describe, expect, it } from "vitest";
import {
	extendSentPayload,
	readSummary,
	summaryInstruction,
	withFileLists,
} from "../../../lib/compaction/index.ts";

describe("summaryInstruction", () => {
	it("asks for the checkpoint format and tells the model not to act", () => {
		const text = summaryInstruction({ hasPreviousSummary: false });
		expect(text).toContain("Do not call any tool");
		expect(text).toContain("## Goal");
		expect(text).toContain("## Critical Context");
		expect(text).toContain("Preserve exact file paths");
		expect(text).not.toContain("begins with a summary");
	});

	it("folds a previous summary in when the conversation starts with one", () => {
		const text = summaryInstruction({ hasPreviousSummary: true });
		expect(text).toContain("begins with a summary");
		expect(text).toContain("PRESERVE");
	});

	it("carries a caller's focus", () => {
		const text = summaryInstruction({
			hasPreviousSummary: false,
			customInstructions: "keep the mastery layer state",
		});
		expect(text).toContain("Additional focus: keep the mastery layer state");
	});
});

describe("readSummary", () => {
	const text = (t: string) => ({ type: "text", text: t });
	type Block = { type: string; text?: string; [key: string]: unknown };
	const blocks = (...b: Block[]) => b;

	it("returns the text of a finished reply, leaving thinking out", () => {
		expect(
			readSummary({
				stopReason: "stop",
				content: blocks(
					{ type: "thinking", thinking: "hmm" },
					text("## Goal\nx"),
				),
			}),
		).toEqual({ ok: true, text: "## Goal\nx" });
	});

	it("refuses a reply cut off at the token cap", () => {
		const outcome = readSummary({
			stopReason: "length",
			content: [text("## Go")],
		});
		expect(outcome.ok).toBe(false);
	});

	it("refuses a reply that called a tool", () => {
		const outcome = readSummary({
			stopReason: "toolUse",
			content: blocks(text("## Goal"), { type: "toolCall", name: "read" }),
		});
		expect(outcome).toEqual({
			ok: false,
			reason: "the summariser called a tool",
		});
	});

	it("refuses an error, naming it", () => {
		expect(
			readSummary({
				stopReason: "error",
				errorMessage: "overloaded",
				content: [],
			}),
		).toEqual({ ok: false, reason: "overloaded" });
	});

	it("refuses an empty reply", () => {
		expect(readSummary({ stopReason: "stop", content: [text("  ")] }).ok).toBe(
			false,
		);
	});
});

describe("withFileLists", () => {
	it("appends read and modified files the way pi's compaction does", () => {
		const out = withFileLists("S", {
			read: new Set(["b.ts", "a.ts", "c.ts"]),
			edited: new Set(["c.ts"]),
			written: new Set(["d.ts"]),
		});
		expect(out.readFiles).toEqual(["a.ts", "b.ts"]);
		expect(out.modifiedFiles).toEqual(["c.ts", "d.ts"]);
		expect(out.summary).toBe(
			"S\n\n<read-files>\na.ts\nb.ts\n</read-files>\n\n<modified-files>\nc.ts\nd.ts\n</modified-files>",
		);
	});

	it("adds nothing when no file was touched", () => {
		const out = withFileLists("S", {
			read: new Set(),
			edited: new Set(),
			written: new Set(),
		});
		expect(out.summary).toBe("S");
	});
});

describe("extendSentPayload", () => {
	const effort = (level: string) => ({
		role: "system",
		content: [],
		output_config: { effort: level },
	});
	const user = (text: string, cached = false) => ({
		role: "user",
		content: [
			{
				type: "text",
				text,
				...(cached ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
			},
		],
	});
	const assistant = (text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
	});
	const sent = {
		model: "claude-opus-5-5",
		system: [{ type: "text", text: "SYSTEM" }],
		tools: [{ name: "read" }],
		thinking: { type: "adaptive" },
		output_config: { effort: "high" },
		max_tokens: 32000,
		stream: true,
		messages: [
			effort("high"),
			assistant("hi"),
			user("go on", true),
			effort("xhigh"),
		],
	};

	it("keeps every byte the session sent and appends the unsent tail", () => {
		const tail = {
			system: [{ type: "text", text: "other" }],
			messages: [
				effort("high"),
				assistant("done"),
				user("summarise", true),
				effort("high"),
			],
		};
		const out = extendSentPayload(sent, tail, 51200);
		if (!out.ok) throw new Error(out.reason);
		expect(out.payload.system).toBe(sent.system);
		expect(out.payload.tools).toBe(sent.tools);
		expect(out.payload.thinking).toBe(sent.thinking);
		expect(out.payload.max_tokens).toBe(51200);
		expect(out.payload.messages).toEqual([
			effort("high"),
			assistant("hi"),
			user("go on", true),
			effort("high"),
			assistant("done"),
			user("summarise"),
			effort("xhigh"),
		]);
	});

	it("writes nothing new to the cache, since no later request reuses the tail", () => {
		const tail = {
			messages: [assistant("done"), user("summarise", true), effort("high")],
		};
		const out = extendSentPayload(sent, tail, 100);
		if (!out.ok) throw new Error(out.reason);
		expect(JSON.stringify(out.payload.messages.slice(3))).not.toContain(
			"cache_control",
		);
		expect(out.payload.messages[2]).toEqual(user("go on", true));
		expect(JSON.stringify(tail)).toContain("cache_control");
	});

	it("leaves the payload the session sent untouched", () => {
		const before = JSON.stringify(sent);
		extendSentPayload(sent, { messages: [assistant("x"), user("s")] }, 100);
		expect(JSON.stringify(sent)).toBe(before);
	});

	it("refuses a tail that carries a system update it cannot place", () => {
		const out = extendSentPayload(
			sent,
			{
				messages: [
					{ role: "system", content: [{ type: "text", text: "new tools" }] },
					user("s"),
				],
			},
			100,
		);
		expect(out.ok).toBe(false);
	});

	it("refuses a payload that is not a messages request", () => {
		expect(extendSentPayload({ input: [] }, { messages: [] }, 100).ok).toBe(
			false,
		);
		expect(extendSentPayload(sent, "nope", 100).ok).toBe(false);
	});
});

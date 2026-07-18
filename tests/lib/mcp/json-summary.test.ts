import { describe, expect, it, vi } from "vitest";
import {
	jsonSummaryContent,
	summarizeJson,
} from "../../../lib/mcp/json-summary.js";
import type { McpContent } from "../../../lib/mcp/types.js";

function textOf(content: McpContent[] | undefined): string {
	return (content ?? [])
		.filter(
			(b): b is Extract<McpContent, { type: "text" }> => b.type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

describe("summarizeJson", () => {
	it("lists top-level object keys with their value types", () => {
		const out = summarizeJson({ name: "x", count: 3, ok: true, missing: null });
		expect(out).toContain("name: string");
		expect(out).toContain("count: number");
		expect(out).toContain("ok: boolean");
		expect(out).toContain("missing: null");
	});

	it("profiles an array of objects with per-key value counts", () => {
		const out = summarizeJson([
			{ status: 200 },
			{ status: 200 },
			{ status: 200 },
			{ status: 500 },
		]);
		expect(out).toContain("array(4");
		expect(out).toContain("status: 200×3");
		expect(out).toContain("500");
	});

	it("unions keys across a heterogeneous array of objects", () => {
		const out = summarizeJson([{ a: 1 }, { b: 2 }]);
		expect(out).toContain("a:");
		expect(out).toContain("b:");
	});

	it("collapses a high-cardinality field to a distinct count", () => {
		const rows = Array.from({ length: 60 }, (_, i) => ({ id: `req-${i}` }));
		const out = summarizeJson(rows);
		expect(out).toContain("distinct");
		expect(out).not.toContain("req-42");
	});

	it("profiles a scalar array by value frequency", () => {
		const out = summarizeJson(["a", "a", "b"]);
		expect(out).toContain("array(3");
		expect(out).toContain("a×2");
		expect(out).toContain("b");
	});

	it("lays the shape across indented lines in pretty mode", () => {
		const compact = summarizeJson({ events: [{ a: 1 }], status: "ok" });
		const pretty = summarizeJson(
			{ events: [{ a: 1 }], status: "ok" },
			{ pretty: true },
		);
		expect(compact).not.toContain("\n");
		expect(pretty).toContain("\n");
		expect(pretty).toContain("events:");
		expect(pretty).toContain("status:");
	});

	it("stops tallying past the element bound and samples the first element", () => {
		const rows = Array.from({ length: 30 }, (_, i) => ({ status: i % 2 }));
		const out = summarizeJson(rows, { maxElements: 10 });
		expect(out).toContain("array(30, first=");
		// No value tally is shown, because that would be a partial scan dressed up
		// as an exact count.
		expect(out).not.toContain("×");
	});

	it("reports a scalar root by type and, for strings, length", () => {
		expect(summarizeJson("hello")).toBe("string(5)");
		expect(summarizeJson(42)).toBe("number");
		expect(summarizeJson(null)).toBe("null");
	});

	it("caps the number of object keys shown and counts the rest", () => {
		const big: Record<string, number> = {};
		for (let i = 0; i < 100; i++) big[`k${i}`] = i;
		const out = summarizeJson(big, { maxKeys: 5 });
		expect(out).toContain("k0: number");
		expect(out).toContain("(+95 more)");
		expect(out).not.toContain("k99");
	});

	it("stops recursing past the depth budget", () => {
		const deep = { a: { b: { c: { d: 1 } } } };
		const out = summarizeJson(deep, { maxDepth: 2 });
		expect(out).not.toContain("d: number");
	});

	it("never exceeds the byte cap", () => {
		const big: Record<string, string> = {};
		for (let i = 0; i < 100; i++) big[`key-number-${i}`] = "value";
		const out = summarizeJson(big, { maxKeys: 100, maxBytes: 80 });
		expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(80);
	});
});

describe("jsonSummaryContent", () => {
	it("summarizes parseable JSON under the gate and spills the full payload", () => {
		const raw = JSON.stringify({ events: [1, 2, 3], status: "ok" });
		const spill = vi.fn(() => ({ path: "/tmp/x", handle: "h1" }));
		const out = jsonSummaryContent({
			rawText: raw,
			spill,
			parseGateBytes: 10_000,
		});
		expect(spill).toHaveBeenCalledWith(raw);
		const text = textOf(out?.content);
		expect(text).toContain("events: array(3");
		expect(text).toContain("h1");
		// The notice steers toward bracket notation for dotted keys.
		expect(text).toContain("bracket notation");
	});

	it("carries a terminal view with a friendly multi-line shape and byte size", () => {
		const raw = JSON.stringify({ events: [{ a: 1 }, { a: 2 }], status: "ok" });
		const spill = vi.fn(() => ({ path: "/tmp/x", handle: "h1" }));
		const out = jsonSummaryContent({
			rawText: raw,
			spill,
			parseGateBytes: 10_000,
		});
		expect(out?.view.handle).toBe("h1");
		expect(out?.view.bytes).toBe(Buffer.byteLength(raw, "utf-8"));
		// The pretty shape is laid out across lines, unlike the compact digest.
		expect(out?.view.pretty).toContain("\n");
		expect(out?.view.pretty).toContain("events:");
	});

	it("returns undefined when the payload exceeds the parse gate", () => {
		const raw = JSON.stringify({ a: "x".repeat(1000) });
		const spill = vi.fn(() => ({ path: "/tmp/x", handle: "h1" }));
		const out = jsonSummaryContent({ rawText: raw, spill, parseGateBytes: 50 });
		expect(out).toBeUndefined();
		expect(spill).not.toHaveBeenCalled();
	});

	it("returns undefined when the spill fails, so the caller falls back to the ceiling", () => {
		const raw = JSON.stringify({ events: [1, 2, 3] });
		const spill = vi.fn(() => {
			throw new Error("disk full");
		});
		const out = jsonSummaryContent({
			rawText: raw,
			spill,
			parseGateBytes: 10_000,
		});
		expect(out).toBeUndefined();
	});

	it("returns undefined for text that is not JSON", () => {
		const spill = vi.fn(() => ({ path: "/tmp/x", handle: "h1" }));
		const out = jsonSummaryContent({
			rawText: "not json at all",
			spill,
			parseGateBytes: 10_000,
		});
		expect(out).toBeUndefined();
		expect(spill).not.toHaveBeenCalled();
	});
});

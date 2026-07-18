import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryStoredJson } from "../../../lib/mcp/query.js";
import { createResultStore } from "../../../lib/mcp/store.js";
import type { McpContent } from "../../../lib/mcp/types.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-query-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function textOf(content: McpContent[]): string {
	return content
		.filter(
			(b): b is Extract<McpContent, { type: "text" }> => b.type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

// The matched-slice JSON is the last text block; a header block precedes it.
function dataOf(content: McpContent[]): string {
	const texts = content.filter(
		(b): b is Extract<McpContent, { type: "text" }> => b.type === "text",
	);
	return texts[texts.length - 1]?.text ?? "";
}

describe("queryStoredJson", () => {
	it("returns the matched slice of a stored payload", () => {
		const store = createResultStore({ dir });
		const { handle } = store.put(
			JSON.stringify({ events: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
		);
		const out = queryStoredJson(store, handle, "$.events[*].id");
		const parsed = JSON.parse(dataOf(out));
		expect(parsed).toEqual([1, 2, 3]);
	});

	it("reports the full match count even when the slice is truncated", () => {
		const store = createResultStore({ dir });
		const { handle } = store.put(
			JSON.stringify({ xs: Array.from({ length: 100 }, (_, i) => i) }),
		);
		const out = queryStoredJson(store, handle, "$.xs[*]", { maxMatches: 5 });
		expect(textOf(out)).toContain("100 matches; showing the first 5");
		expect(JSON.parse(dataOf(out))).toHaveLength(5);
	});

	it("runs a filter expression and can project a single field from the matches", () => {
		const store = createResultStore({ dir });
		const { handle } = store.put(
			JSON.stringify({
				events: [
					{ id: 1, status: 200 },
					{ id: 2, status: 500 },
					{ id: 3, status: 500 },
				],
			}),
		);
		const out = queryStoredJson(store, handle, "$.events[?(@.status==500)].id");
		expect(JSON.parse(dataOf(out))).toEqual([2, 3]);
	});

	it("caps the number of matches returned", () => {
		const store = createResultStore({ dir });
		const { handle } = store.put(
			JSON.stringify({ xs: Array.from({ length: 100 }, (_, i) => i) }),
		);
		const out = queryStoredJson(store, handle, "$.xs[*]", { maxMatches: 5 });
		expect(JSON.parse(dataOf(out))).toHaveLength(5);
	});

	it("explains an unknown handle rather than throwing", () => {
		const store = createResultStore({ dir });
		const out = queryStoredJson(store, "nope", "$.a");
		expect(textOf(out).toLowerCase()).toContain("handle");
	});

	it("clamps a negative maxMatches instead of returning almost everything", () => {
		const store = createResultStore({ dir });
		const { handle } = store.put(
			JSON.stringify({ xs: Array.from({ length: 20 }, (_, i) => i) }),
		);
		const out = queryStoredJson(store, handle, "$.xs[*]", { maxMatches: -5 });
		expect(JSON.parse(dataOf(out))).toHaveLength(0);
	});

	it("explains when nothing matches rather than returning an empty blob", () => {
		const store = createResultStore({ dir });
		const { handle } = store.put(JSON.stringify({ a: 1 }));
		const out = queryStoredJson(store, handle, "$.missing");
		expect(textOf(out).toLowerCase()).toContain("no match");
	});

	it("re-caps an oversized query result through the store", () => {
		const store = createResultStore({ dir });
		const big = Array.from({ length: 500 }, (_, i) => ({
			id: i,
			blob: "z".repeat(200),
		}));
		const { handle } = store.put(JSON.stringify({ items: big }));
		const out = queryStoredJson(store, handle, "$.items[*]", {
			limitBytes: 1000,
		});
		const totalBytes = out
			.filter(
				(b): b is Extract<McpContent, { type: "text" }> => b.type === "text",
			)
			.reduce((sum, b) => sum + Buffer.byteLength(b.text, "utf-8"), 0);
		expect(totalBytes).toBeLessThanOrEqual(1000);
	});
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryStored } from "../../../lib/result/query.js";
import {
	createResultStore,
	type ResultStore,
} from "../../../lib/result/store.js";

/** The text of an answer, as a caller would read it. */
function textOf(answer: { blocks: readonly { text: string }[] }): string {
	return answer.blocks.map((b) => b.text).join("\n");
}

describe("queryStored", () => {
	let dir: string;
	let store: ResultStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "query-"));
		store = createResultStore({ dir });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("projects the fields an expression names", () => {
		const { handle } = store.put(
			JSON.stringify({
				nodes: [
					{ role: "button", name: "Save" },
					{ role: "link", name: "Home" },
				],
			}),
		);

		const answer = queryStored(store, handle, "$.nodes[*].name");

		expect(answer.matches).toBe(2);
		expect(textOf(answer)).toContain("Save");
		expect(textOf(answer)).toContain("Home");
		// A projection returns the field, not the record around it.
		expect(textOf(answer)).not.toContain("button");
	});

	it("filters, which is the reason for having a language at all", () => {
		const { handle } = store.put(
			JSON.stringify({
				requests: [
					{ url: "/a", status: 200 },
					{ url: "/b", status: 500 },
					{ url: "/c", status: 500 },
				],
			}),
		);

		const answer = queryStored(
			store,
			handle,
			"$.requests[?(@.status==500)].url",
		);

		expect(answer.matches).toBe(2);
		expect(textOf(answer)).toContain("/b");
		expect(textOf(answer)).toContain("/c");
		expect(textOf(answer)).not.toContain("/a");
	});

	it("reports the total before the cap, so a broad query answers how many", () => {
		const rows = Array.from({ length: 500 }, (_, i) => ({ i }));
		const { handle } = store.put(JSON.stringify({ rows }));

		const answer = queryStored(store, handle, "$.rows[*].i", {
			maxMatches: 10,
		});

		// The count is over everything; only the serialization is capped.
		expect(answer.matches).toBe(rows.length);
		expect(textOf(answer)).toContain(`${rows.length} matches`);
		expect(textOf(answer)).toContain("showing the first 10");
		expect(JSON.parse(answer.json as string)).toHaveLength(10);
	});

	it("explains an expired handle instead of throwing", () => {
		const answer = queryStored(store, "never-issued", "$..*");

		expect(answer.matches).toBeUndefined();
		expect(textOf(answer)).toContain("no longer available");
	});

	it("teaches bracket notation when a dotted key finds nothing", () => {
		const { handle } = store.put(JSON.stringify({ "a.b.c": 1 }));

		const answer = queryStored(store, handle, "$.nope");

		expect(textOf(answer)).toContain("no matches");
		expect(textOf(answer)).toContain("@['a.b.c']");
	});

	it("says a payload is not JSON rather than failing obscurely", () => {
		const { handle } = store.put("this was never JSON");

		const answer = queryStored(store, handle, "$..*");

		expect(textOf(answer)).toContain("not valid JSON");
	});
});

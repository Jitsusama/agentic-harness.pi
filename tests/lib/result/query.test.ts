import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_ANSWER_BYTES,
	queryStored,
} from "../../../lib/result/query.js";
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

	describe("the size of an answer", () => {
		/** A payload far larger than any answer should be. */
		function bulk(): string {
			return JSON.stringify({
				rows: Array.from({ length: 400 }, (_, i) => ({
					id: i,
					name: `record number ${i}`,
					note: "a field long enough that four hundred of them matter",
				})),
			});
		}

		it("refuses to hand back the whole payload it was asked to hold", () => {
			const payload = bulk();
			const { handle } = store.put(payload);

			// The expression a caller reaches for first, and the one that
			// undoes the storing if nothing bounds the answer: select every
			// record. maxMatches alone does not save this, because four
			// hundred whole records is under the hundred-match cap only if
			// you count matches rather than bytes.
			const answer = queryStored(store, handle, "$.rows[*]", {
				maxMatches: 400,
			});

			// Measured against the payload rather than against the default,
			// so the claim holds whatever the default is set to. A default
			// larger than the payloads anyone stores is not a bound at all,
			// and an assertion phrased against it would pass while saying
			// nothing.
			expect(Buffer.byteLength(textOf(answer), "utf-8")).toBeLessThan(
				Buffer.byteLength(payload, "utf-8") / 2,
			);
			expect(DEFAULT_ANSWER_BYTES).toBeLessThan(
				Buffer.byteLength(payload, "utf-8"),
			);
		});

		it("cites a handle for the part of the answer it did not show", () => {
			const { handle } = store.put(bulk());

			const answer = queryStored(store, handle, "$.rows[*]", {
				maxMatches: 400,
				limitBytes: 512,
			});
			const text = textOf(answer);

			// A cut answer has to be followable, or the caller is worse off
			// than before they asked: they have neither the records nor a
			// way to reach them.
			const handleInText = /handle (result-[0-9a-f]{16})/.exec(text);
			expect(handleInText).not.toBeNull();

			const followed = queryStored(
				store,
				(handleInText as RegExpExecArray)[1],
				"$[0].name",
			);
			expect(textOf(followed)).toContain("record number 0");
		});

		it("still reports the true match count when it cut the answer", () => {
			const { handle } = store.put(bulk());

			const answer = queryStored(store, handle, "$.rows[*]", {
				maxMatches: 400,
				limitBytes: 512,
			});

			// Counting is the cheapest thing a broad expression is for, and
			// it must survive the cut that the same expression provokes.
			expect(textOf(answer)).toContain("400 matches");
			expect(answer.matches).toBe(400);
		});

		it("leaves an answer that fits completely alone", () => {
			const { handle } = store.put(
				JSON.stringify({ rows: [{ name: "only one" }] }),
			);

			const answer = queryStored(store, handle, "$.rows[*].name");
			const text = textOf(answer);

			expect(text).toContain("only one");
			expect(text).not.toContain("handle result-");
		});
	});
});

import { afterEach, describe, expect, it } from "vitest";
import {
	listAnswer,
	pageAnswer,
} from "../../../extensions/browser-integration/stored.js";
import {
	cleanupSessionResults,
	createResultStore,
	sessionResultDir,
} from "../../../lib/result/index.js";
import type { AxNode } from "../../../lib/web/a11y/index.js";
import { renderAxOutline } from "../../../lib/web/a11y/index.js";
import type { Observation } from "../../../lib/web/session.js";

/**
 * A page like the one that caused this: rows of listitems, each
 * with a button and a text node, thousands of them.
 */
function hugePage(rows: number): Observation {
	const children: AxNode[] = [];
	for (let row = 1; row <= rows; row++) {
		children.push({
			role: "listitem",
			name: "",
			properties: {},
			children: [
				{
					role: "button",
					name: `Select line ${row}`,
					properties: {},
					children: [],
				},
				{
					role: "StaticText",
					name: `line ${row} of source`,
					properties: {},
					children: [],
				},
			],
		});
	}
	const tree: AxNode = {
		role: "RootWebArea",
		name: "big",
		properties: {},
		children: [{ role: "list", name: "", properties: {}, children }],
	};
	return {
		url: "https://example.test/big",
		title: "big",
		outline: renderAxOutline(tree),
		tree,
	};
}

/** The handle a citation names, if it named one. */
function handleIn(text: string): string | undefined {
	return /handle (result-[0-9a-f]{16})/.exec(text)?.[1];
}

describe("pageAnswer", () => {
	afterEach(() => {
		cleanupSessionResults();
	});

	it("answers a huge page in kilobytes, not megabytes", () => {
		// The defect: a wheel scroll answered with 2.54 MB, the whole
		// outline of an eighteen thousand line file.
		const observed = hugePage(4_000);
		const wholeOutline = Buffer.byteLength(observed.outline, "utf-8");

		const text = pageAnswer(observed, 4_096);

		// Well under what the page renders, and near the budget it was
		// given rather than merely smaller than the page.
		expect(wholeOutline).toBeGreaterThan(200_000);
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(6_000);
	});

	it("keeps every node reachable through the handle it cites", () => {
		const observed = hugePage(4_000);

		const text = pageAnswer(observed, 4_096);
		const handle = handleIn(text);

		expect(handle).toBeDefined();
		const stored = createResultStore({ dir: sessionResultDir() });
		const payload = JSON.parse(stored.read(handle as string)) as {
			url: string;
			nodes: { role: string; children?: unknown[] }[];
		};
		// The payload is the page, not the excerpt that was shown.
		expect(payload.url).toBe(observed.url);
		expect(payload.nodes[0]?.children).toHaveLength(4_000);
	});

	it("says how to narrow, in the vocabulary the tool accepts", () => {
		const text = pageAnswer(hugePage(4_000), 4_096);

		expect(text).toContain("'only'");
		expect(text).toContain("'depth'");
		expect(text).toContain("'within'");
		expect(text).toContain("result_query");
	});

	it("leaves a page that fits completely alone", () => {
		const small = hugePage(2);

		const text = pageAnswer(small, 16_384);

		// No citation, no advice, no machinery: the view is the truth.
		expect(handleIn(text)).toBeUndefined();
		expect(text).not.toContain("result_query");
		expect(text).toContain("Select line 2");
	});
});

describe("listAnswer", () => {
	afterEach(() => {
		cleanupSessionResults();
	});

	it("cites the records rather than the lines it cut", () => {
		const records = Array.from({ length: 600 }, (_, i) => ({
			url: `https://example.test/asset-${i}`,
			status: i % 7 === 0 ? 500 : 200,
		}));
		const view = records
			.map((r, i) => `#${i + 1}  GET  ${r.status}  ${r.url}`)
			.join("\n");

		const text = listAnswer({
			view,
			records,
			unit: "requests",
			narrowing: "Narrow with 'filter'.",
			budget: 2_048,
		});
		const handle = handleIn(text);

		expect(handle).toBeDefined();
		expect(text).toContain("Narrow with 'filter'.");
		// The caller must know the payload holds requests, not lines,
		// or their first expression will be written against the wrong
		// shape.
		expect(text).toContain("600 requests themselves");
		const stored = createResultStore({ dir: sessionResultDir() });
		expect(JSON.parse(stored.read(handle as string))).toHaveLength(600);
	});
});

import { afterEach, describe, expect, it } from "vitest";
import {
	bodyAnswer,
	listAnswer,
	pageAnswer,
	storageAnswer,
} from "../../../extensions/browser-integration/stored.js";
import {
	cleanupSessionResults,
	createResultStore,
	offerQueryTool,
	sessionResultDir,
	withdrawQueryTool,
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
		withdrawQueryTool();
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
		// The query tool comes from a different extension, so a citation
		// only names it when that extension is loaded. Here it is.
		offerQueryTool("result_query");
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
		// shape. Both counts are named in one sentence: what is stored
		// and how much of the rendering they are looking at. It used to
		// claim the lines were stored and then append a sentence taking
		// that back, which driving Slack for real made obvious.
		expect(text).toContain("All 600 requests are stored under handle");
		expect(text).toMatch(/renders \d+ of 600 lines/);
		expect(text).not.toContain("600 lines are stored");
		const stored = createResultStore({ dir: sessionResultDir() });
		expect(JSON.parse(stored.read(handle as string))).toHaveLength(600);
	});

	describe("what a page read says it stored", () => {
		it("names nodes as the payload, not the lines it rendered", () => {
			const text = pageAnswer(hugePage(2_000), 4_096);

			// The same two-count rule the listings follow. A page citation
			// counting only lines sends the first expression at a shape the
			// payload does not have, which is the defect driving Slack
			// surfaced and which this path never got.
			expect(text).toMatch(/All [\d,]+ nodes are stored under handle/);
			expect(text).toMatch(/renders [\d,]+ of [\d,]+ outline lines/);
			expect(text).not.toMatch(/All [\d,]+ outline lines are stored/);
		});

		it("keeps the states the outline showed", () => {
			const tree: AxNode = {
				role: "RootWebArea",
				name: "form",
				properties: {},
				children: Array.from({ length: 400 }, (_, i) => ({
					role: "checkbox",
					name: `Option ${i}`,
					properties: { checked: "true", required: true },
					children: [],
				})),
			};
			const observed: Observation = {
				url: "https://example.test/form",
				title: "form",
				outline: renderAxOutline(tree),
				tree,
			};

			const text = pageAnswer(observed, 512);
			const handle = handleIn(text);
			expect(handle).toBeDefined();

			// The visible outline reports these, and the shipped skill tells
			// the model the stored nodes carry them. A payload that drops
			// them is lossier than the view it was meant to make queryable,
			// and the query that goes looking returns nothing with no clue
			// why.
			const stored = createResultStore({ dir: sessionResultDir() });
			const payload = stored.read(handle as string);
			expect(payload).toContain("checked");
			expect(payload).toContain("required");
		});
	});
});

describe("a storage read", () => {
	afterEach(() => {
		withdrawQueryTool();
		cleanupSessionResults();
	});

	it("keeps the value it could not show", () => {
		// A real page put a megabyte of cached modules under one
		// local storage key. The view cut it to a preview, said how
		// many characters it had, and offered no way to ask for the
		// rest: there is no argument that fetches one key.
		const hoard = JSON.stringify({ items: "m".repeat(60_000) });

		const text = storageAnswer({
			local: [
				["MediaWikiModuleStore:enwiki", hoard],
				["sessionTickCount", "2"],
			],
			cookies: [{ name: "GeoIP", value: "CA:ON" }],
		});
		const handle = handleIn(text);

		expect(text).toContain("MediaWikiModuleStore:enwiki");
		expect(handle).toBeDefined();
		const stored = createResultStore({ dir: sessionResultDir() });
		const payload = JSON.parse(stored.read(handle as string));
		expect(payload.local[0].value).toBe(hoard);
		expect(payload.cookies[0].name).toBe("GeoIP");
	});

	it("says nothing extra when every value fits", () => {
		const text = storageAnswer({
			local: [["theme", "dark"]],
			session: [],
		});

		expect(text).toContain("dark");
		expect(text).not.toContain("handle result-");
	});
});

describe("a response body", () => {
	it("keeps the bytes it could not show", () => {
		const body = "x".repeat(40_000);

		const text = bodyAnswer("https://example.test/app.js", body, 1_024);
		const handle = handleIn(text);

		// The old form cut the body, said how many bytes it had thrown
		// away, and offered no way to ask for them: a cut announced is
		// still a cut. Counted in bytes because a minified body is one
		// line as long as the file.
		expect(handle).toBeDefined();
		expect(text).toContain("40,000 bytes are stored");
		const stored = createResultStore({ dir: sessionResultDir() });
		expect(JSON.parse(stored.read(handle as string))).toHaveLength(40_000);
	});

	it("says nothing extra about a body that fits", () => {
		const text = bodyAnswer("https://example.test/small", "hello", 1_024);

		expect(text).toContain("hello");
		expect(text).not.toContain("handle result-");
	});
});

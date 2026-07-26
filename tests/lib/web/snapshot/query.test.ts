/**
 * Querying the flattened page.
 */

import { describe, expect, it } from "vitest";
import type { IndexedNode } from "../../../../lib/web/snapshot/flatten.js";
import {
	describeNode,
	find,
	matches,
	tally,
} from "../../../../lib/web/snapshot/query.js";

const node = (over: Partial<IndexedNode> = {}): IndexedNode => ({
	id: "0:1",
	documentIndex: 0,
	documentUrl: "http://localhost/",
	nodeName: "DIV",
	nodeType: 1,
	backendNodeId: 1,
	attributes: {},
	styles: {},
	clickable: false,
	inShadow: false,
	rendered: true,
	...over,
});

describe("matches", () => {
	it("matches a tag whatever case it is asked for in", () => {
		expect(matches(node({ nodeName: "BUTTON" }), { tag: "button" })).toBe(true);
	});

	it("matches on an attribute being present", () => {
		expect(
			matches(node({ attributes: { "data-test": "x" } }), {
				attribute: "data-test",
			}),
		).toBe(true);
	});

	it("matches on an attribute's value when one is given", () => {
		const target = node({ attributes: { role: "button" } });
		expect(matches(target, { attribute: "role", value: "button" })).toBe(true);
		expect(matches(target, { attribute: "role", value: "link" })).toBe(false);
	});

	it("matches a class without matching a longer one that contains it", () => {
		const target = node({ attributes: { class: "card cardinal" } });
		expect(matches(target, { className: "card" })).toBe(true);
		expect(matches(target, { className: "car" })).toBe(false);
	});

	it("matches text case-insensitively", () => {
		expect(matches(node({ text: "Save Changes" }), { text: "save" })).toBe(
			true,
		);
	});

	it("can ask for exactly what was not rendered", () => {
		expect(matches(node({ rendered: false }), { rendered: false })).toBe(true);
		expect(matches(node({ rendered: true }), { rendered: false })).toBe(false);
	});

	it("can ask only for shadow content", () => {
		expect(matches(node({ inShadow: true }), { inShadow: true })).toBe(true);
	});

	it("can narrow to one frame", () => {
		expect(
			matches(node({ documentUrl: "http://a/f.html" }), {
				documentUrl: "http://a/f.html",
			}),
		).toBe(true);
	});

	it("requires every stated condition, not any of them", () => {
		const target = node({ nodeName: "BUTTON", rendered: false });
		expect(matches(target, { tag: "button", rendered: true })).toBe(false);
	});

	it("matches everything when asked for nothing", () => {
		expect(matches(node(), {})).toBe(true);
	});
});

describe("find", () => {
	const page = [
		node({ id: "0:1", nodeName: "DIV" }),
		node({ id: "0:2", nodeName: "BUTTON", clickable: true }),
		node({ id: "0:3", nodeName: "BUTTON", rendered: false }),
	];

	it("returns matches in the order given", () => {
		expect(find(page, { tag: "button" }).map((n) => n.id)).toEqual([
			"0:2",
			"0:3",
		]);
	});

	it("returns nothing rather than failing when nothing matches", () => {
		expect(find(page, { tag: "canvas" })).toEqual([]);
	});
});

describe("tally", () => {
	it("counts by whatever is asked for, largest first", () => {
		const page = [
			node({ nodeName: "DIV" }),
			node({ nodeName: "DIV" }),
			node({ nodeName: "SPAN" }),
		];
		expect(tally(page, (n) => n.nodeName)).toEqual([
			{ key: "DIV", count: 2 },
			{ key: "SPAN", count: 1 },
		]);
	});

	it("skips nodes the key does not apply to", () => {
		const page = [node({ attributes: { id: "a" } }), node()];
		expect(tally(page, (n) => n.attributes.id)).toEqual([
			{ key: "a", count: 1 },
		]);
	});

	it("breaks ties by name so the order is stable", () => {
		const page = [node({ nodeName: "B" }), node({ nodeName: "A" })];
		expect(tally(page, (n) => n.nodeName).map((t) => t.key)).toEqual([
			"A",
			"B",
		]);
	});
});

describe("describeNode", () => {
	it("reads like a selector", () => {
		expect(
			describeNode(
				node({
					nodeName: "DIV",
					attributes: { id: "main", class: "card wide" },
				}),
			),
		).toContain("div#main.card.wide");
	});

	it("says where it is when it was laid out", () => {
		expect(
			describeNode(
				node({ bounds: { x: 24, y: 95.4, width: 752, height: 35 } }),
			),
		).toContain("24,95 752x35");
	});

	it("says plainly when a node was not rendered", () => {
		expect(describeNode(node({ rendered: false }))).toContain("not rendered");
	});

	it("marks shadow content, which is otherwise indistinguishable", () => {
		expect(describeNode(node({ inShadow: true }))).toContain("in shadow");
	});

	it("clips long text rather than spending the budget on it", () => {
		const long = "x".repeat(200);
		const out = describeNode(node({ text: long }));
		expect(out.length).toBeLessThan(80);
		expect(out).toContain("...");
	});

	it("collapses whitespace so a listing stays on one line", () => {
		expect(describeNode(node({ text: "two\n\n   words" }))).toContain(
			'"two words"',
		);
	});
});

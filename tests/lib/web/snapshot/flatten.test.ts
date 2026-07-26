/**
 * Flattening a DOM snapshot. The fixture mirrors the real packed
 * shape: one shared string table, parallel node arrays, sparse
 * rare properties, and a layout array covering only what the
 * browser actually rendered.
 */

import { describe, expect, it } from "vitest";
import {
	flattenSnapshot,
	type IndexedNode,
	isElement,
	isText,
	type RawSnapshot,
} from "../../../../lib/web/snapshot/flatten.js";

const STRINGS = [
	"http://localhost/deep.html", // 0
	"#document", // 1
	"HTML", // 2
	"BODY", // 3
	"DIV", // 4
	"id", // 5
	"plain", // 6
	"gone", // 7
	"block", // 8
	"none", // 9
	"BUTTON", // 10
	"Shadow button", // 11
	"open", // 12
	"IFRAME", // 13
	"http://localhost/framed.html", // 14
	"", // 15
	"class", // 16
	"card", // 17
];

/**
 * A page with: a rendered div, a display:none div, a custom
 * element whose shadow tree holds a button, and an iframe
 * hosting a second document.
 *
 * The shadow shape here is the real one, checked against a live
 * capture: there is no separate shadow-root node, the content
 * hangs directly off the host, and shadowRootType marks every
 * node of the tree rather than only its root.
 */
const SNAPSHOT: RawSnapshot = {
	strings: STRINGS,
	documents: [
		{
			documentURL: 0,
			nodes: {
				//      0:#document 1:HTML 2:BODY 3:DIV 4:DIV 5:HOST 6:BUTTON 7:IFRAME
				parentIndex: [-1, 0, 1, 2, 2, 2, 5, 2],
				nodeType: [9, 1, 1, 1, 1, 1, 1, 1],
				nodeName: [1, 2, 3, 4, 4, 1, 10, 13],
				nodeValue: [15, 15, 15, 15, 15, 15, 15, 15],
				backendNodeId: [100, 101, 102, 103, 104, 105, 106, 107],
				attributes: [[], [], [], [5, 6, 16, 17], [5, 7], [], [], []],
				// The button is inside the shadow tree; its host is not.
				shadowRootType: { index: [6], value: [12] },
				isClickable: { index: [6] },
				contentDocumentIndex: { index: [7], value: [1] },
			},
			layout: {
				// The hidden div (node 4) has no layout entry at all.
				nodeIndex: [0, 1, 2, 3, 5, 6, 7],
				styles: [[], [8, 15], [8, 15], [8, 15], [8, 15], [8, 15], [8, 15]],
				bounds: [
					[0, 0, 800, 600],
					[0, 0, 800, 349],
					[8, 8, 784, 333],
					[24, 95, 752, 35],
					[24, 178, 225, 17],
					[24, 178, 120, 17],
					[24, 198, 304, 124],
				],
				text: [-1, -1, -1, -1, -1, 11, -1],
			},
		},
		{
			documentURL: 14,
			nodes: {
				parentIndex: [-1, 0, 1],
				nodeType: [9, 1, 1],
				nodeName: [1, 2, 10],
				nodeValue: [15, 15, 15],
				backendNodeId: [200, 201, 202],
				attributes: [[], [], []],
			},
			layout: {
				nodeIndex: [0, 1, 2],
				styles: [[], [8, 15], [8, 15]],
				bounds: [
					[0, 0, 300, 120],
					[0, 0, 300, 84],
					[8, 55, 95, 21],
				],
			},
		},
	],
};

const flat = flattenSnapshot(SNAPSHOT, ["display", "opacity"]);
const byId = (id: string): IndexedNode => {
	const found = flat.find((node) => node.id === id);
	if (!found) throw new Error(`no node ${id}`);
	return found;
};

describe("flattenSnapshot", () => {
	it("returns every node from every document", () => {
		expect(flat).toHaveLength(11);
	});

	it("resolves the string table", () => {
		expect(byId("0:3").nodeName).toBe("DIV");
		expect(byId("0:6").nodeName).toBe("BUTTON");
	});

	it("unpacks attributes into pairs", () => {
		expect(byId("0:3").attributes).toEqual({ id: "plain", class: "card" });
	});

	it("gives nodes ids unique across documents", () => {
		expect(new Set(flat.map((node) => node.id)).size).toBe(flat.length);
	});

	it("zips styles against the order they were requested in", () => {
		// The protocol returns a bare array positioned against the
		// request and never names the properties again.
		expect(byId("0:1").styles).toEqual({ display: "block" });
	});

	it("gives bounds to what was laid out", () => {
		expect(byId("0:3").bounds).toEqual({
			x: 24,
			y: 95,
			width: 752,
			height: 35,
		});
	});

	it("marks a node the browser never laid out as unrendered", () => {
		// This is the browser's own answer, and the only one that
		// accounts for an ancestor being hidden.
		expect(byId("0:4").rendered).toBe(false);
		expect(byId("0:4").bounds).toBeUndefined();
		expect(byId("0:3").rendered).toBe(true);
	});

	it("keeps the unrendered node rather than dropping it", () => {
		// It is still in the DOM, and the reason something is missing
		// from the page is usually the most interesting question.
		expect(byId("0:4").attributes.id).toBe("gone");
	});

	it("knows which nodes live inside a shadow tree", () => {
		// The protocol marks every node of the tree, not just its
		// root, so this is the browser's answer rather than one
		// derived by walking ancestors.
		expect(byId("0:6").inShadow).toBe(true);
		expect(byId("0:3").inShadow).toBe(false);
	});

	it("does not call the host of a shadow tree shadowed", () => {
		expect(byId("0:5").inShadow).toBe(false);
		expect(byId("0:2").inShadow).toBe(false);
	});

	it("carries the clickable flag the browser worked out", () => {
		expect(byId("0:6").clickable).toBe(true);
		expect(byId("0:3").clickable).toBe(false);
	});

	it("includes nodes from framed documents", () => {
		expect(byId("1:2").nodeName).toBe("BUTTON");
		expect(byId("1:2").documentUrl).toBe("http://localhost/framed.html");
	});

	it("joins a frame to the element that hosts it", () => {
		// Otherwise the page is several disconnected trees and no
		// question about containment can be answered.
		expect(byId("1:0").parent).toBe("0:7");
	});

	it("leaves the top document without a parent", () => {
		expect(byId("0:0").parent).toBeUndefined();
	});

	it("keeps text belonging to the node that rendered it", () => {
		expect(byId("0:6").text).toBe("Shadow button");
		expect(byId("0:3").text).toBeUndefined();
	});

	it("survives a snapshot with no rare properties at all", () => {
		const framed = SNAPSHOT.documents[1];
		if (!framed) throw new Error("the fixture lost its frame");
		const plain = flattenSnapshot({ ...SNAPSHOT, documents: [framed] }, [
			"display",
		]);
		expect(plain.every((node) => !node.inShadow)).toBe(true);
		expect(plain.every((node) => !node.clickable)).toBe(true);
	});

	it("tells elements from text", () => {
		expect(isElement(byId("0:3"))).toBe(true);
		expect(isText(byId("0:3"))).toBe(false);
	});
});

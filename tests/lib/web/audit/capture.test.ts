/**
 * Joining a DOM snapshot to an accessibility tree.
 *
 * The focusability half of this join is what the hidden-focusable
 * rule stands on, and it is easy to get confidently wrong. The
 * accessibility tree says nothing at all about any node it
 * ignored, and an aria-hidden subtree is exactly what it ignores,
 * so the join falls back to markup. Markup knows an input is
 * focusable and knows nothing about why this particular one is
 * not.
 *
 * Every fixture here mirrors a real capture of a page with two
 * closed dialogs: their contents are aria-hidden, laid out, and
 * hidden by visibility rather than display.
 */

import { describe, expect, it } from "vitest";
import {
	type AxFacts,
	buildStructure,
} from "../../../../lib/web/audit/capture.js";
import type { IndexedNode } from "../../../../lib/web/snapshot/flatten.js";

const node = (over: Partial<IndexedNode> & { id: string }): IndexedNode => ({
	documentIndex: 0,
	documentUrl: "https://example.test/",
	nodeName: "INPUT",
	nodeType: 1,
	backendNodeId: Number(over.id.replace(/\D/g, "")) || 1,
	attributes: {},
	styles: { visibility: "visible", display: "block" },
	clickable: false,
	inShadow: false,
	rendered: true,
	...over,
});

const focusableOf = (
	nodes: readonly IndexedNode[],
	facts: readonly AxFacts[] = [],
): Record<string, boolean> =>
	Object.fromEntries(
		buildStructure(nodes, facts).map((one) => [one.id, one.focusable]),
	);

describe("what the join decides can take focus", () => {
	it("trusts markup when the tree stayed silent", () => {
		// The reason the fallback exists: an ignored node carries no
		// properties, and reading that as "cannot take focus" left
		// the hidden-focusable rule unable to see its own subject.
		expect(focusableOf([node({ id: "1" })])).toEqual({ "1": true });
	});

	it("refuses a control hidden by visibility, however good its markup", () => {
		// 42 of the 48 false criticals on the real page were this.
		// visibility inherits, so the computed value on the control
		// already carries its hidden ancestor's answer.
		expect(
			focusableOf([
				node({ id: "1", styles: { visibility: "hidden", display: "block" } }),
			]),
		).toEqual({ "1": false });
	});

	it("refuses a control under collapse, which hides the same way", () => {
		expect(
			focusableOf([
				node({ id: "1", styles: { visibility: "collapse", display: "block" } }),
			]),
		).toEqual({ "1": false });
	});

	it("lets a control opt back in with visibility:visible", () => {
		// A child may overrule a hidden ancestor. Asking the element
		// rather than walking ancestors is what makes this work.
		expect(
			focusableOf([
				node({ id: "1", styles: { visibility: "visible", display: "block" } }),
			]),
		).toEqual({ "1": true });
	});

	it("refuses a control that was never laid out", () => {
		expect(focusableOf([node({ id: "1", rendered: false })])).toEqual({
			"1": false,
		});
	});

	it("refuses a control inside an inert subtree", () => {
		// inert changes nothing about how a subtree looks, so no
		// style question finds it. A closed dialog is the ordinary
		// case.
		const parent = node({
			id: "1",
			nodeName: "DIV",
			attributes: { inert: "" },
		});
		const child = node({ id: "2", parent: "1" });
		expect(focusableOf([parent, child])["2"]).toBe(false);
	});

	it("refuses a control inert by a grandparent, not just a parent", () => {
		const grand = node({
			id: "1",
			nodeName: "DIV",
			attributes: { inert: "" },
		});
		const middle = node({ id: "2", nodeName: "DIV", parent: "1" });
		const child = node({ id: "3", parent: "2" });
		expect(focusableOf([grand, middle, child])["3"]).toBe(false);
	});

	it("takes the tree's word over markup when the tree spoke", () => {
		// A div with a tabindex is focusable and no tag list says so;
		// when the tree describes a node, it is the better answer.
		const div = node({
			id: "7",
			nodeName: "DIV",
			backendNodeId: 7,
			attributes: { tabindex: "0" },
		});
		expect(
			focusableOf([div], [{ backendNodeId: 7, focusable: true }])["7"],
		).toBe(true);
	});

	it("believes the tree when it says a visible control cannot focus", () => {
		const input = node({ id: "8", backendNodeId: 8 });
		expect(
			focusableOf([input], [{ backendNodeId: 8, focusable: false }])["8"],
		).toBe(false);
	});

	it("still refuses a disabled control", () => {
		expect(
			focusableOf([node({ id: "1", attributes: { disabled: "" } })]),
		).toEqual({ "1": false });
	});

	it("still refuses a negative tabindex", () => {
		expect(
			focusableOf([node({ id: "1", attributes: { tabindex: "-1" } })]),
		).toEqual({ "1": false });
	});

	it("refuses an anchor with no href", () => {
		expect(focusableOf([node({ id: "1", nodeName: "A" })])).toEqual({
			"1": false,
		});
	});
});

import { describe, expect, it } from "vitest";
import {
	type AxNode,
	renderAxOutline,
	scopeTree,
	subtreeAt,
} from "../../../../lib/web/a11y/index.js";

function node(
	role: string,
	name: string,
	children: AxNode[] = [],
	backendDomId?: number,
): AxNode {
	return {
		role,
		name,
		...(backendDomId === undefined ? {} : { backendDomId }),
		properties: {},
		children,
	};
}

/** A page with landmarks, headings, controls and filler. */
const page = node("RootWebArea", "Shop", [
	node("banner", "", [
		node("navigation", "Main", [node("link", "Home", [], 1)]),
	]),
	node("main", "", [
		node("heading", "Pricing", [], 2),
		node("generic", "", [
			node("paragraph", "", [node("StaticText", "Body copy")]),
			node("heading", "Plans", [], 3),
			node("button", "Buy", [], 4),
		]),
	]),
	node("contentinfo", "", [node("StaticText", "Footer")]),
]);

describe("scopeTree", () => {
	it("returns the whole tree when nothing is asked of it", () => {
		expect(scopeTree(page, {})).toEqual(page);
	});

	it("cuts the tree to a depth measured the way the outline reads", () => {
		// The generic wrapper is folded when rendering, so it must
		// not silently consume one of the levels the caller asked
		// for.
		const outline = renderAxOutline(scopeTree(page, { depth: 2 }));
		expect(outline).toBe(
			[
				"banner",
				'  navigation "Main"',
				"main",
				'  heading "Pricing"',
				"  paragraph",
				'  heading "Plans"',
				'  button "Buy"',
				"contentinfo",
				'  StaticText "Footer"',
			].join("\n"),
		);
	});

	it("keeps only the landmarks when asked for the skeleton", () => {
		const outline = renderAxOutline(scopeTree(page, { only: "landmarks" }));
		expect(outline).toBe(
			["banner", '  navigation "Main"', "main", "contentinfo"].join("\n"),
		);
	});

	it("keeps only the headings when asked for them", () => {
		const outline = renderAxOutline(scopeTree(page, { only: "headings" }));
		expect(outline).toBe(['heading "Pricing"', 'heading "Plans"'].join("\n"));
	});

	it("keeps only what a caller can operate", () => {
		const outline = renderAxOutline(scopeTree(page, { only: "interactive" }));
		expect(outline).toBe(['link "Home"', 'button "Buy"'].join("\n"));
	});

	it("applies a skeleton and a depth together", () => {
		const outline = renderAxOutline(
			scopeTree(page, { only: "landmarks", depth: 1 }),
		);
		expect(outline).toBe(["banner", "main", "contentinfo"].join("\n"));
	});
});

describe("subtreeAt", () => {
	it("finds the branch rooted at an element", () => {
		const branch = subtreeAt(page, 3);
		expect(branch?.role).toBe("heading");
		expect(branch?.name).toBe("Plans");
	});

	it("keeps the branch's own children", () => {
		const banner = page.children[0] as AxNode;
		const nav = banner.children[0] as AxNode;
		const found = subtreeAt(page, 1);
		expect(found).toEqual(nav.children[0]);
	});

	it("reports nothing when no element carries that id", () => {
		expect(subtreeAt(page, 999)).toBeUndefined();
	});
});

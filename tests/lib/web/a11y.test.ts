import { describe, expect, it } from "vitest";
import { type AxNode, renderAxOutline } from "../../../lib/web/a11y.js";

function node(role: string, name: string, children: AxNode[] = []): AxNode {
	return { role, name, children };
}

describe("renderAxOutline", () => {
	it("renders roles and names nested by containment", () => {
		const tree = node("document", "", [
			node("navigation", "Primary", [
				node("link", "Home"),
				node("link", "About"),
			]),
			node("button", "Sign in"),
		]);
		expect(renderAxOutline(tree)).toBe(
			[
				'navigation "Primary"',
				'  link "Home"',
				'  link "About"',
				'button "Sign in"',
			].join("\n"),
		);
	});

	it("drops structurally noisy nodes but keeps their named descendants", () => {
		// A generic wrapper with no name should not add a level.
		const tree = node("document", "", [
			node("generic", "", [
				node("heading", "Welcome"),
				node("none", "", [node("paragraph", "Body")]),
			]),
		]);
		expect(renderAxOutline(tree)).toBe(
			['heading "Welcome"', 'paragraph "Body"'].join("\n"),
		);
	});

	it("keeps a named node even when its role is generic", () => {
		const tree = node("document", "", [
			node("generic", "Labelled region", [node("link", "Deep")]),
		]);
		expect(renderAxOutline(tree)).toBe(
			['generic "Labelled region"', '  link "Deep"'].join("\n"),
		);
	});
});

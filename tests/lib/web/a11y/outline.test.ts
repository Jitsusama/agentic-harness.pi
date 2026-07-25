import { describe, expect, it } from "vitest";
import {
	type AxNode,
	type AxProperties,
	renderAxOutline,
} from "../../../../lib/web/a11y/index.js";

function node(
	role: string,
	name: string,
	children: AxNode[] = [],
	extra: { properties?: AxProperties; value?: string | number } = {},
): AxNode {
	return {
		role,
		name,
		properties: extra.properties ?? {},
		...(extra.value !== undefined ? { value: extra.value } : {}),
		children,
	};
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

	it("says when a control is checked, disabled or expanded", () => {
		const tree = node("document", "", [
			node("checkbox", "Remember me", [], {
				properties: { checked: "true" },
			}),
			node("button", "Save", [], { properties: { disabled: true } }),
			node("button", "Details", [], { properties: { expanded: false } }),
		]);
		expect(renderAxOutline(tree)).toBe(
			[
				'checkbox "Remember me" checked',
				'button "Save" disabled',
				'button "Details" collapsed',
			].join("\n"),
		);
	});

	it("gives a heading its level", () => {
		const tree = node("document", "", [
			node("heading", "Pricing", [], { properties: { level: 2 } }),
		]);
		expect(renderAxOutline(tree)).toBe('heading "Pricing" level 2');
	});

	it("shows a field's value and whether it is required or invalid", () => {
		const tree = node("document", "", [
			node("textbox", "Email", [], {
				value: "a@b.c",
				properties: { required: true },
			}),
			node("textbox", "Password", [], {
				properties: { invalid: "true" },
			}),
		]);
		expect(renderAxOutline(tree)).toBe(
			[
				'textbox "Email" required value "a@b.c"',
				'textbox "Password" invalid',
			].join("\n"),
		);
	});

	it("stays quiet about states that are not in effect", () => {
		// A false 'required' or an invalid of "false" is the normal
		// case and would be noise on every line.
		const tree = node("document", "", [
			node("textbox", "Email", [], {
				properties: {
					required: false,
					invalid: "false",
					focusable: true,
					editable: "plaintext",
				},
			}),
		]);
		expect(renderAxOutline(tree)).toBe('textbox "Email"');
	});

	it("marks the focused element so a keyboard walk can be followed", () => {
		const tree = node("document", "", [
			node("link", "Home", [], { properties: { focused: true } }),
		]);
		expect(renderAxOutline(tree)).toBe('link "Home" focused');
	});

	it("reports a live region's politeness", () => {
		const tree = node("document", "", [
			node("status", "Saved", [], { properties: { live: "polite" } }),
		]);
		expect(renderAxOutline(tree)).toBe('status "Saved" live polite');
	});
});

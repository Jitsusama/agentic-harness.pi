import { describe, expect, it } from "vitest";
import {
	type AxNode,
	type AxProperties,
	renderReading,
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
		...(extra.value === undefined ? {} : { value: extra.value }),
		children,
	};
}

describe("renderReading", () => {
	it("announces a landmark on the way in and on the way out", () => {
		const tree = node("RootWebArea", "Shop", [
			node("navigation", "Main", [node("link", "Home")]),
		]);
		expect(renderReading(tree)).toBe(
			["navigation, Main", "  link, Home", "end of navigation, Main"].join(
				"\n",
			),
		);
	});

	it("reads a heading with its level", () => {
		const tree = node("RootWebArea", "", [
			node("heading", "Pricing", [], { properties: { level: 2 } }),
		]);
		expect(renderReading(tree)).toBe("heading level 2, Pricing");
	});

	it("reads a control with the states that affect using it", () => {
		const tree = node("RootWebArea", "", [
			node("checkbox", "Remember me", [], { properties: { checked: "true" } }),
			node("button", "Save", [], { properties: { disabled: true } }),
			node("textbox", "Email", [], {
				value: "a@b.c",
				properties: { required: true },
			}),
		]);
		expect(renderReading(tree)).toBe(
			[
				"checkbox, Remember me, checked",
				"button, Save, disabled",
				'textbox, Email, required, value "a@b.c"',
			].join("\n"),
		);
	});

	it("reads text as prose rather than as an element", () => {
		const tree = node("RootWebArea", "", [
			node("paragraph", "", [node("StaticText", "Some words.")]),
		]);
		expect(renderReading(tree)).toBe("Some words.");
	});

	it("says when an element is the one holding focus", () => {
		const tree = node("RootWebArea", "", [
			node("link", "Home", [], { properties: { focused: true } }),
		]);
		expect(renderReading(tree)).toBe("link, Home, focused");
	});

	it("names a live region's politeness so an announcement is expected", () => {
		const tree = node("RootWebArea", "", [
			node("status", "", [node("StaticText", "Saved")], {
				properties: { live: "polite" },
			}),
		]);
		expect(renderReading(tree)).toBe(
			["status, live polite", "  Saved", "end of status"].join("\n"),
		);
	});

	it("does not announce a wrapper that carries no meaning", () => {
		const tree = node("RootWebArea", "", [
			node("generic", "", [node("button", "Go")]),
		]);
		expect(renderReading(tree)).toBe("button, Go");
	});

	it("says how many items a list holds and reads them inside it", () => {
		const tree = node("RootWebArea", "", [
			node("list", "", [
				node("listitem", "", [node("StaticText", "One")]),
				node("listitem", "", [node("StaticText", "Two")]),
			]),
		]);
		expect(renderReading(tree)).toBe(
			["list, 2 items", "  One", "  Two", "end of list"].join("\n"),
		);
	});

	it("says one item rather than 1 items", () => {
		const tree = node("RootWebArea", "", [
			node("list", "", [node("listitem", "", [node("StaticText", "Only")])]),
		]);
		expect(renderReading(tree)).toBe(
			["list, 1 item", "  Only", "end of list"].join("\n"),
		);
	});

	it("stays silent about the popup scaffolding behind a select", () => {
		const tree = node("RootWebArea", "", [
			node("combobox", "Plan", [
				node("MenuListPopup", "", [node("option", "Pro")]),
			]),
		]);
		expect(renderReading(tree)).toBe(
			["combobox, Plan", "option, Pro"].join("\n"),
		);
	});

	it("reads an empty page as saying nothing", () => {
		expect(renderReading(node("RootWebArea", "", []))).toBe("");
	});
});

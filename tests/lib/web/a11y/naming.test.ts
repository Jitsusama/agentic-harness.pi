import { describe, expect, it } from "vitest";
import {
	isWeakName,
	type NameSource,
	nameSource,
	normalizeAxTree,
	type RawAxNameSource,
	type RawAxNode,
} from "../../../../lib/web/a11y/index.js";

/** A node whose name came from the given sources. */
function named(
	name: string,
	sources: RawAxNameSource[],
	role = "button",
): RawAxNode {
	return {
		nodeId: "1",
		role: { value: role },
		name: { value: name, sources },
	};
}

/** The source Chrome marks as the one it used. */
function used(
	source: Omit<RawAxNameSource, "value">,
	value = "x",
): RawAxNameSource {
	return { ...source, value: { value } };
}

/** A source Chrome considered and passed over. */
function beaten(source: Omit<RawAxNameSource, "value">): RawAxNameSource {
	return { ...source, superseded: true, value: { value: "ignored" } };
}

describe("nameSource", () => {
	const cases: ReadonlyArray<[string, RawAxNameSource[], NameSource]> = [
		[
			"aria-labelledby",
			[used({ type: "relatedElement", attribute: "aria-labelledby" })],
			"labelledby",
		],
		[
			"aria-label",
			[used({ type: "attribute", attribute: "aria-label" })],
			"label",
		],
		[
			"a label element",
			[used({ type: "relatedElement", nativeSource: "labelfor" })],
			"nativeLabel",
		],
		[
			"a wrapping label",
			[used({ type: "relatedElement", nativeSource: "labelwrapped" })],
			"nativeLabel",
		],
		["its own text", [used({ type: "contents" })], "content"],
		["a title", [used({ type: "attribute", attribute: "title" })], "title"],
		[
			"a placeholder",
			[used({ type: "placeholder", attribute: "placeholder" })],
			"placeholder",
		],
		["alt text", [used({ type: "attribute", attribute: "alt" })], "alt"],
		[
			"a value attribute",
			[used({ type: "attribute", attribute: "value" })],
			"value",
		],
	];

	for (const [label, sources, expected] of cases) {
		it(`reports a name that came from ${label}`, () => {
			expect(nameSource(named("Something", sources))).toBe(expected);
		});
	}

	it("ignores sources that were considered and passed over", () => {
		const node = named("Real", [
			beaten({ type: "relatedElement", attribute: "aria-labelledby" }),
			used({ type: "attribute", attribute: "aria-label" }),
			beaten({ type: "contents" }),
			beaten({ type: "attribute", attribute: "title" }),
		]);
		expect(nameSource(node)).toBe("label");
	});

	it("ignores a source the page got wrong", () => {
		const node = named("Real", [
			{
				type: "relatedElement",
				attribute: "aria-labelledby",
				invalid: true,
				value: { value: "broken" },
			},
			used({ type: "contents" }),
		]);
		expect(nameSource(node)).toBe("content");
	});

	it("says unnamed when nothing produced a name", () => {
		const node = named("", [
			{ type: "attribute", attribute: "aria-label" },
			{ type: "contents" },
		]);
		expect(nameSource(node)).toBe("unnamed");
	});

	it("says unnamed when the capture reports no sources at all", () => {
		expect(nameSource({ nodeId: "1", role: { value: "button" } })).toBe(
			"unnamed",
		);
	});
});

describe("isWeakName", () => {
	it("counts a title or placeholder as a weak way to name a control", () => {
		expect(isWeakName("title")).toBe(true);
		expect(isWeakName("placeholder")).toBe(true);
	});

	it("counts a real label or the element's own text as sound", () => {
		expect(isWeakName("label")).toBe(false);
		expect(isWeakName("labelledby")).toBe(false);
		expect(isWeakName("nativeLabel")).toBe(false);
		expect(isWeakName("content")).toBe(false);
		expect(isWeakName("alt")).toBe(false);
	});
});

describe("normalizeAxTree name derivation", () => {
	it("records on each node how its name was produced", () => {
		const tree = normalizeAxTree([
			{
				nodeId: "1",
				role: { value: "RootWebArea" },
				name: { value: "" },
				childIds: ["2"],
			},
			{
				nodeId: "2",
				parentId: "1",
				role: { value: "textbox" },
				name: {
					value: "Email",
					sources: [used({ type: "placeholder", attribute: "placeholder" })],
				},
			},
		]);
		expect(tree.children[0]?.nameFrom).toBe("placeholder");
	});

	it("leaves nameFrom off a node the capture said nothing about", () => {
		const tree = normalizeAxTree([
			{
				nodeId: "1",
				role: { value: "RootWebArea" },
				name: { value: "" },
				childIds: ["2"],
			},
			{
				nodeId: "2",
				parentId: "1",
				role: { value: "button" },
				name: { value: "Save" },
			},
		]);
		expect(tree.children[0]?.nameFrom).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import {
	normalizeAxTree,
	type RawAxNode,
	renderAxOutline,
	spliceFrames,
} from "../../../../lib/web/a11y/index.js";

/** Build a raw CDP node with sane defaults. */
function raw(node: Partial<RawAxNode> & { nodeId: string }): RawAxNode {
	return {
		role: { value: "generic" },
		name: { value: "" },
		...node,
	};
}

describe("normalizeAxTree", () => {
	it("keeps the states that say what a control is doing", () => {
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "checkbox" },
				name: { value: "Remember me" },
				properties: [
					{ name: "checked", value: { type: "tristate", value: "true" } },
					{ name: "focusable", value: { type: "boolean", value: true } },
				],
			}),
		]);

		const checkbox = tree.children[0];
		expect(checkbox?.role).toBe("checkbox");
		expect(checkbox?.properties.checked).toBe("true");
		expect(checkbox?.properties.focusable).toBe(true);
	});

	it("keeps a control's current value and a heading's level", () => {
		const tree = normalizeAxTree([
			raw({
				nodeId: "1",
				role: { value: "RootWebArea" },
				childIds: ["2", "3"],
			}),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "slider" },
				name: { value: "Volume" },
				value: { type: "number", value: 7 },
			}),
			raw({
				nodeId: "3",
				parentId: "1",
				role: { value: "heading" },
				name: { value: "Pricing" },
				properties: [{ name: "level", value: { type: "integer", value: 2 } }],
			}),
		]);

		expect(tree.children[0]?.value).toBe(7);
		expect(tree.children[1]?.properties.level).toBe(2);
	});

	it("folds away a text carrier that only repeats its parent's name", () => {
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "button" },
				name: { value: "Save" },
				childIds: ["3"],
			}),
			raw({
				nodeId: "3",
				parentId: "2",
				role: { value: "StaticText" },
				name: { value: "Save" },
				childIds: ["4"],
			}),
			raw({
				nodeId: "4",
				parentId: "3",
				role: { value: "InlineTextBox" },
				name: { value: "Save" },
			}),
		]);

		const button = tree.children[0];
		expect(button?.name).toBe("Save");
		expect(button?.children).toEqual([]);
	});

	it("keeps text that is content rather than a repeat of a label", () => {
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({ nodeId: "2", parentId: "1", childIds: ["3"] }),
			raw({
				nodeId: "3",
				parentId: "2",
				role: { value: "StaticText" },
				name: { value: "Some prose the page is actually saying." },
			}),
		]);

		const texts: string[] = [];
		const walk = (n: { name: string; children: readonly unknown[] }): void => {
			if (n.name) texts.push(n.name);
			for (const c of n.children)
				walk(c as { name: string; children: readonly unknown[] });
		};
		walk(tree);
		expect(texts).toContain("Some prose the page is actually saying.");
	});

	it("folds a text carrier that repeats a grandparent's name", () => {
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "link" },
				name: { value: "Alpha" },
				childIds: ["3"],
			}),
			raw({ nodeId: "3", parentId: "2", childIds: ["4"] }),
			raw({
				nodeId: "4",
				parentId: "3",
				role: { value: "StaticText" },
				name: { value: "Alpha" },
			}),
		]);

		const link = tree.children[0];
		expect(link?.name).toBe("Alpha");
		const names: string[] = [];
		const walk = (n: { name: string; children: readonly unknown[] }): void => {
			for (const c of n.children) {
				const child = c as { name: string; children: readonly unknown[] };
				names.push(child.name);
				walk(child);
			}
		};
		walk(link as never);
		expect(names).not.toContain("Alpha");
	});

	it("folds a label whose text is already the control's name", () => {
		// A <label for> becomes a LabelText sibling of the control
		// it names. A screen reader announces it as part of the
		// control, so the outline should not list it twice.
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "form" },
				childIds: ["3", "5"],
			}),
			raw({
				nodeId: "3",
				parentId: "2",
				role: { value: "LabelText" },
				childIds: ["4"],
			}),
			raw({
				nodeId: "4",
				parentId: "3",
				role: { value: "StaticText" },
				name: { value: "Email" },
			}),
			raw({
				nodeId: "5",
				parentId: "2",
				role: { value: "textbox" },
				name: { value: "Email" },
			}),
		]);

		const form = tree.children[0];
		expect(form?.children.map((c) => c.role)).toEqual(["textbox"]);
	});

	it("folds text that only repeats the control's own value", () => {
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "textbox" },
				name: { value: "Email" },
				value: { type: "string", value: "a@b.c" },
				childIds: ["3"],
			}),
			raw({
				nodeId: "3",
				parentId: "2",
				role: { value: "StaticText" },
				name: { value: "a@b.c" },
			}),
		]);

		expect(tree.children[0]?.children).toEqual([]);
	});

	it("drops presentational list marking", () => {
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "listitem" },
				childIds: ["3", "4"],
			}),
			raw({
				nodeId: "3",
				parentId: "2",
				role: { value: "ListMarker" },
				name: { value: "\u2022 " },
			}),
			raw({
				nodeId: "4",
				parentId: "2",
				role: { value: "StaticText" },
				name: { value: "One" },
			}),
		]);

		const item = tree.children[0];
		expect(item?.children.map((c) => c.name)).toEqual(["One"]);
	});

	it("keeps sibling text that is not a repeat of anything", () => {
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "form" },
				childIds: ["3", "4"],
			}),
			raw({
				nodeId: "3",
				parentId: "2",
				role: { value: "textbox" },
				name: { value: "Password" },
			}),
			raw({
				nodeId: "4",
				parentId: "2",
				role: { value: "StaticText" },
				name: { value: "Too short" },
			}),
		]);

		const form = tree.children[0];
		expect(form?.children.map((c) => c.name)).toEqual([
			"Password",
			"Too short",
		]);
	});

	it("carries the backend DOM id so an element can be resolved later", () => {
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "button" },
				name: { value: "Save" },
				backendDOMNodeId: 42,
			}),
		]);

		expect(tree.children[0]?.backendDomId).toBe(42);
	});

	it("keeps exposed children of an ignored wrapper", () => {
		// A real capture buries the page under ignored html and
		// body wrappers. Pruning them takes the whole page with
		// them; they are unexposed, not empty.
		const tree = normalizeAxTree([
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "none" },
				ignored: true,
				childIds: ["3"],
			}),
			raw({
				nodeId: "3",
				parentId: "2",
				role: { value: "none" },
				ignored: true,
				childIds: ["4"],
			}),
			raw({
				nodeId: "4",
				parentId: "3",
				role: { value: "main" },
				name: { value: "Content" },
			}),
		]);

		expect(tree.children.map((c) => c.role)).toEqual(["main"]);
		expect(tree.children[0]?.name).toBe("Content");
	});

	it("drops an ignored node that has nothing exposed beneath it", () => {
		const tree = normalizeAxTree([
			raw({
				nodeId: "1",
				role: { value: "RootWebArea" },
				childIds: ["2", "3"],
			}),
			raw({
				nodeId: "2",
				parentId: "1",
				role: { value: "button" },
				name: { value: "Hidden" },
				ignored: true,
			}),
			raw({
				nodeId: "3",
				parentId: "1",
				role: { value: "button" },
				name: { value: "Shown" },
			}),
		]);

		expect(tree.children.map((c) => c.name)).toEqual(["Shown"]);
	});

	it("survives a tree with no nodes at all", () => {
		const tree = normalizeAxTree([]);
		expect(tree.children).toEqual([]);
	});
});

describe("splicing a frame's tree into the page's", () => {
	const main: RawAxNode[] = [
		raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
		raw({
			nodeId: "2",
			role: { value: "Iframe" },
			name: { value: "Inner frame" },
			parentId: "1",
			backendDOMNodeId: 14,
			childIds: [],
		}),
	];

	const inner: RawAxNode[] = [
		raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
		raw({
			nodeId: "2",
			role: { value: "heading" },
			name: { value: "Inner heading" },
			parentId: "1",
		}),
	];

	it("hangs the frame's content under the iframe that owns it", () => {
		// A frame is a boundary for the DOM, not for a reader. Before
		// this, every reading stopped at the Iframe node and the whole
		// of what the frame contained was absent.
		const spliced = spliceFrames(main, [
			{ ownerBackendNodeId: 14, nodes: inner },
		]);

		expect(renderAxOutline(normalizeAxTree(spliced))).toContain(
			"Inner heading",
		);
	});

	it("keeps the two frames' node ids apart", () => {
		// Both trees number their nodes from one. Merged without
		// renaming, the frame's root collides with the page's, and the
		// walk either loses nodes or never comes back.
		const spliced = spliceFrames(main, [
			{ ownerBackendNodeId: 14, nodes: inner },
		]);

		expect(new Set(spliced.map((node) => node.nodeId)).size).toBe(
			spliced.length,
		);
	});

	it("leaves the page alone when no iframe owns the frame", () => {
		// A frame whose owner is not in this tree is not ours to
		// attach. Hanging it off the root would invent a relationship
		// the page does not have.
		const spliced = spliceFrames(main, [
			{ ownerBackendNodeId: 999, nodes: inner },
		]);

		expect(spliced).toEqual(main);
	});

	it("changes nothing when there are no frames", () => {
		expect(spliceFrames(main, [])).toEqual(main);
	});

	it("splices a frame inside a frame", () => {
		// Nesting is ordinary on a page built from embeds, and a pass
		// that only handles depth one truncates without saying so.
		const deepest: RawAxNode[] = [
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				role: { value: "heading" },
				name: { value: "Deepest heading" },
				parentId: "1",
			}),
		];
		const middle: RawAxNode[] = [
			raw({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }),
			raw({
				nodeId: "2",
				role: { value: "Iframe" },
				name: { value: "Deeper frame" },
				parentId: "1",
				backendDOMNodeId: 27,
				childIds: [],
			}),
		];

		const spliced = spliceFrames(main, [
			{ ownerBackendNodeId: 14, nodes: middle },
			{ ownerBackendNodeId: 27, nodes: deepest },
		]);

		expect(renderAxOutline(normalizeAxTree(spliced))).toContain(
			"Deepest heading",
		);
	});
});

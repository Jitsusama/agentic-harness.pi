/**
 * Structural rules.
 *
 * Each rule gets its own small capture rather than one shared
 * page, so a failure names the rule that broke rather than
 * sending the reader hunting through a fixture.
 */

import { describe, expect, it } from "vitest";
import {
	analyseStructure,
	brokenReferences,
	formLabelling,
	headingOutline,
	hiddenButFocusable,
	landmarkNaming,
	manualTabOrder,
	nestedInteractives,
	type StructureNode,
} from "../../../../lib/web/audit/structure.js";

const node = (
	over: Partial<StructureNode> & { id: string },
): StructureNode => ({
	selector: `#${over.id}`,
	tag: "div",
	attributes: {},
	focusable: false,
	rendered: true,
	ancestors: [],
	...over,
});

describe("a reference to something not built yet", () => {
	// Mirrors real markup from two widely used React widget
	// libraries: a collapsed combobox and a collapsed toggle
	// button, each naming a popup that only exists once opened.
	// axe declines to fail these while aria-expanded is "false",
	// and says so in its own source; this rule used to call them
	// critical, so a correct page opened with two critical WCAG
	// failures.
	it("excuses aria-controls while the widget is collapsed", () => {
		expect(
			brokenReferences([
				node({
					id: "toggle",
					attributes: {
						"aria-controls": "menu-that-is-not-there",
						"aria-expanded": "false",
					},
				}),
			]),
		).toEqual([]);
	});

	it("excuses aria-owns on the same grounds", () => {
		expect(
			brokenReferences([
				node({
					id: "owner",
					attributes: { "aria-owns": "ghost", "aria-expanded": "false" },
				}),
			]),
		).toEqual([]);
	});

	it("still fails aria-controls once the widget says it is open", () => {
		// Expanded and pointing at nothing is a real defect: the
		// popup is supposedly on screen and cannot be found.
		const [found] = brokenReferences([
			node({
				id: "open",
				attributes: { "aria-controls": "ghost", "aria-expanded": "true" },
			}),
		]);
		expect(found?.rule).toBe("reference-resolves");
	});

	it("still fails aria-controls when there is no disclosure at all", () => {
		// No aria-expanded means this is not a widget that reveals
		// anything, so there is nothing to wait for.
		const [found] = brokenReferences([
			node({ id: "plain", attributes: { "aria-controls": "ghost" } }),
		]);
		expect(found?.rule).toBe("reference-resolves");
	});

	it("never excuses aria-labelledby, which erases the name", () => {
		// The excuse is about things rendered on demand. A name is
		// not one of them, collapsed or not.
		const [found] = brokenReferences([
			node({
				id: "named",
				attributes: {
					"aria-labelledby": "ghost",
					"aria-expanded": "false",
				},
			}),
		]);
		expect(found?.rule).toBe("reference-resolves");
	});

	it("excuses a deselected tab, as axe does", () => {
		expect(
			brokenReferences([
				node({
					id: "tab",
					attributes: {
						"aria-controls": "panel",
						"aria-selected": "false",
					},
				}),
			]),
		).toEqual([]);
	});
});

describe("brokenReferences", () => {
	it("catches an aria-labelledby pointing at nothing", () => {
		const [found] = brokenReferences([
			node({ id: "a", attributes: { "aria-labelledby": "ghost" } }),
		]);
		expect(found?.rule).toBe("reference-resolves");
		expect(found?.nodes[0]?.messages[0]).toContain("'ghost'");
	});

	it("says nothing when the reference resolves", () => {
		expect(
			brokenReferences([
				node({ id: "a", attributes: { "aria-labelledby": "real" } }),
				node({ id: "b", attributes: { id: "real" } }),
			]),
		).toEqual([]);
	});

	it("reads a multi-id list and names only the missing ones", () => {
		const [found] = brokenReferences([
			node({ id: "a", attributes: { "aria-labelledby": "here gone" } }),
			node({ id: "b", attributes: { id: "here" } }),
		]);
		const message = found?.nodes[0]?.messages[0] ?? "";
		expect(message).toContain("'gone'");
		expect(message).not.toContain("'here'");
	});

	it("treats aria-activedescendant as a single id, not a list", () => {
		// Splitting it on whitespace would invent ids nobody wrote.
		const [found] = brokenReferences([
			node({ id: "a", attributes: { "aria-activedescendant": "one two" } }),
		]);
		expect(found?.nodes[0]?.messages[0]).toContain("'one two'");
	});

	it("checks a label's for attribute too", () => {
		const [found] = brokenReferences([
			node({ id: "l", tag: "label", attributes: { for: "nowhere" } }),
		]);
		expect(found?.nodes).toHaveLength(1);
	});

	it("calls it critical, because a broken name erases rather than degrades", () => {
		const [found] = brokenReferences([
			node({ id: "a", attributes: { "aria-describedby": "ghost" } }),
		]);
		expect(found?.impact).toBe("critical");
	});
});

describe("hiddenButFocusable", () => {
	it("catches an element that is both aria-hidden and focusable", () => {
		const [found] = hiddenButFocusable([
			node({ id: "a", focusable: true, attributes: { "aria-hidden": "true" } }),
		]);
		expect(found?.nodes).toHaveLength(1);
	});

	it("catches a focusable child of an aria-hidden container", () => {
		const [found] = hiddenButFocusable([
			node({ id: "wrap", attributes: { "aria-hidden": "true" } }),
			node({ id: "btn", focusable: true, ancestors: ["wrap"] }),
		]);
		expect(found?.nodes[0]?.messages[0]).toContain("#wrap");
	});

	it("leaves a hidden element alone when it cannot take focus", () => {
		expect(
			hiddenButFocusable([
				node({ id: "a", attributes: { "aria-hidden": "true" } }),
			]),
		).toEqual([]);
	});

	it("ignores something the browser never drew", () => {
		expect(
			hiddenButFocusable([
				node({
					id: "a",
					focusable: true,
					rendered: false,
					attributes: { "aria-hidden": "true" },
				}),
			]),
		).toEqual([]);
	});
});

describe("nestedInteractives", () => {
	it("catches a button inside a link", () => {
		const [found] = nestedInteractives([
			node({ id: "link", role: "link" }),
			node({ id: "btn", role: "button", ancestors: ["link"] }),
		]);
		expect(found?.nodes[0]?.messages[0]).toContain("button inside a link");
	});

	it("catches it through a plain wrapper in between", () => {
		const [found] = nestedInteractives([
			node({ id: "link", role: "link" }),
			node({ id: "wrap", ancestors: ["link"] }),
			node({ id: "btn", role: "button", ancestors: ["wrap", "link"] }),
		]);
		expect(found?.nodes).toHaveLength(1);
	});

	it("leaves siblings alone", () => {
		expect(
			nestedInteractives([
				node({ id: "a", role: "button" }),
				node({ id: "b", role: "link" }),
			]),
		).toEqual([]);
	});

	it("does not mind an interactive inside a plain container", () => {
		expect(
			nestedInteractives([
				node({ id: "wrap" }),
				node({ id: "btn", role: "button", ancestors: ["wrap"] }),
			]),
		).toEqual([]);
	});
});

describe("headingOutline", () => {
	const heading = (id: string, level: number) =>
		node({ id, tag: `h${level}`, role: "heading", name: id });

	it("catches a jump from two to four", () => {
		const found = headingOutline([
			heading("a", 1),
			heading("b", 2),
			heading("c", 4),
		]);
		expect(found[0]?.rule).toBe("heading-skips-level");
		expect(found[0]?.nodes[0]?.messages[0]).toContain("level 3");
	});

	it("allows going back down any number of levels", () => {
		// Descending is how sections end; only climbing can skip.
		const found = headingOutline([
			heading("a", 1),
			heading("b", 2),
			heading("c", 3),
			heading("d", 1),
		]);
		expect(found.filter((f) => f.rule === "heading-skips-level")).toEqual([]);
	});

	it("reports a page with two level ones", () => {
		const found = headingOutline([heading("a", 1), heading("b", 1)]);
		expect(found.some((f) => f.rule === "single-first-heading")).toBe(true);
	});

	it("says nothing about a page with exactly one level one", () => {
		const found = headingOutline([heading("a", 1), heading("b", 2)]);
		expect(found).toEqual([]);
	});

	it("reads a level from aria-level on a role of heading", () => {
		const found = headingOutline([
			heading("a", 1),
			node({
				id: "b",
				role: "heading",
				attributes: { "aria-level": "4" },
			}),
		]);
		expect(found[0]?.rule).toBe("heading-skips-level");
	});

	it("calls a missing first heading nobody's failure, since it is not one", () => {
		expect(headingOutline([heading("a", 2), heading("b", 3)])).toEqual([]);
	});
});

describe("landmarkNaming", () => {
	it("catches two unnamed navigations", () => {
		const [found] = landmarkNaming([
			node({ id: "a", role: "navigation" }),
			node({ id: "b", role: "navigation" }),
		]);
		expect(found?.nodes).toHaveLength(2);
	});

	it("is happy when they are named apart", () => {
		expect(
			landmarkNaming([
				node({ id: "a", role: "navigation", name: "Primary" }),
				node({ id: "b", role: "navigation", name: "Footer" }),
			]),
		).toEqual([]);
	});

	it("is happy when only one of the pair is unnamed", () => {
		// The named one distinguishes itself; the other is "the
		// other one", which is followable.
		expect(
			landmarkNaming([
				node({ id: "a", role: "navigation", name: "Primary" }),
				node({ id: "b", role: "navigation" }),
			]),
		).toEqual([]);
	});

	it("does not mind a single unnamed landmark", () => {
		expect(landmarkNaming([node({ id: "a", role: "main" })])).toEqual([]);
	});

	it("treats a whitespace name as no name", () => {
		const [found] = landmarkNaming([
			node({ id: "a", role: "navigation", name: "   " }),
			node({ id: "b", role: "navigation" }),
		]);
		expect(found?.nodes).toHaveLength(2);
	});
});

describe("formLabelling", () => {
	it("catches an ARIA field with no accessible name", () => {
		const found = formLabelling([node({ id: "i", role: "textbox" })]);
		expect(found[0]?.rule).toBe("aria-field-has-name");
	});

	it("leaves native fields to axe, which checks them harder", () => {
		// axe has a rule per labelling mechanism for native inputs.
		// Reporting them here as well is a second entry saying the
		// same thing, which helps nobody.
		expect(
			formLabelling([node({ id: "i", tag: "input", role: "textbox" })]),
		).toEqual([]);
	});

	it("is satisfied by a name however it was given", () => {
		expect(
			formLabelling([node({ id: "i", role: "textbox", name: "Email" })]),
		).toEqual([]);
	});

	it("catches an invalid field that explains nothing", () => {
		const found = formLabelling([
			node({
				id: "i",
				role: "textbox",
				name: "Email",
				attributes: { "aria-invalid": "true" },
			}),
		]);
		expect(found[0]?.rule).toBe("error-is-announced");
	});

	it("still checks error association on a native field", () => {
		// Leaving natives to axe applies to naming only. axe has no
		// rule for error association, so excluding natives here
		// silently dropped the check on exactly the elements that
		// most often carry it.
		const found = formLabelling([
			node({
				id: "i",
				tag: "input",
				role: "textbox",
				name: "Email",
				attributes: { "aria-invalid": "true" },
			}),
		]);
		expect(found.map((rule) => rule.rule)).toEqual(["error-is-announced"]);
	});

	it("ignores a hidden input, which nobody types into", () => {
		expect(
			formLabelling([
				node({
					id: "i",
					tag: "input",
					attributes: { type: "hidden", "aria-invalid": "true" },
				}),
			]),
		).toEqual([]);
	});

	it("accepts aria-describedby as the explanation", () => {
		expect(
			formLabelling([
				node({
					id: "i",
					role: "textbox",
					name: "Email",
					attributes: {
						"aria-invalid": "true",
						"aria-describedby": "why",
					},
				}),
			]),
		).toEqual([]);
	});
});

describe("manualTabOrder", () => {
	it("catches a positive tabindex", () => {
		const [found] = manualTabOrder([
			node({ id: "a", attributes: { tabindex: "3" } }),
		]);
		expect(found?.nodes).toHaveLength(1);
	});

	it("leaves zero and minus one alone, which are normal", () => {
		expect(
			manualTabOrder([
				node({ id: "a", attributes: { tabindex: "0" } }),
				node({ id: "b", attributes: { tabindex: "-1" } }),
			]),
		).toEqual([]);
	});
});

describe("analyseStructure", () => {
	it("runs every rule and returns them together", () => {
		const rules = analyseStructure([
			node({ id: "ref", attributes: { "aria-labelledby": "ghost" } }),
			node({ id: "tab", attributes: { tabindex: "4" } }),
			node({ id: "h1", tag: "h1", role: "heading" }),
			node({ id: "h3", tag: "h3", role: "heading" }),
		]);
		expect([...rules.map((rule) => rule.rule)].sort()).toEqual([
			"heading-skips-level",
			"no-positive-tabindex",
			"reference-resolves",
		]);
	});

	it("says nothing at all about a page that is fine", () => {
		expect(
			analyseStructure([
				node({ id: "h1", tag: "h1", role: "heading", name: "Title" }),
				node({ id: "main", role: "main" }),
			]),
		).toEqual([]);
	});
});

describe("a rule has to be able to see its own subject", () => {
	it("finds a focusable control inside an aria-hidden subtree", () => {
		// The accessibility tree reports no properties at all for a
		// node it ignored, and an aria-hidden subtree is exactly
		// what it ignores. Reading focusable off the tree therefore
		// always answered false here and this critical rule could
		// never fire on the case it exists for. Measured against a
		// live page before changing it: zero findings.
		const nodes: StructureNode[] = [
			{
				id: "n1",
				selector: "div",
				tag: "div",
				attributes: { "aria-hidden": "true" },
				focusable: false,
				rendered: true,
				ancestors: [],
				html: '<div aria-hidden="true">',
			},
			{
				id: "n2",
				selector: "#reachable",
				tag: "button",
				attributes: { id: "reachable" },
				focusable: true,
				rendered: true,
				ancestors: ["n1"],
				html: '<button id="reachable">',
			},
		];

		const found = hiddenButFocusable(nodes);

		expect(found).toHaveLength(1);
		expect(found[0]?.nodes[0]?.selector).toBe("#reachable");
	});
});

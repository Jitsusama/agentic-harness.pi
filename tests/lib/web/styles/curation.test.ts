import { describe, expect, it } from "vitest";
import {
	type ComputedStyles,
	type CurateOptions,
	curateStyles as curateWithout,
} from "../../../../lib/web/styles/index.js";

/**
 * What Chrome reports for an element with all:initial, read
 * from a real browser. These are the browser's values, not a
 * table maintained here.
 */
const INITIALS = {
	display: "inline",
	position: "static",
	margin: "0px",
	padding: "0px",
	"border-width": "0px",
	"border-style": "none",
	"outline-style": "none",
	"outline-width": "3px",
	transform: "none",
	"font-weight": "400",
	"text-align": "start",
	"background-color": "rgba(0, 0, 0, 0)",
	"accent-color": "auto",
	"margin-top": "0px",
	"margin-right": "0px",
	"margin-bottom": "0px",
	"margin-left": "0px",
	"padding-top": "0px",
	"padding-right": "0px",
	"padding-bottom": "0px",
	"padding-left": "0px",
	"border-top-width": "0px",
	"border-right-width": "0px",
	"border-bottom-width": "0px",
	"border-left-width": "0px",
	"border-top-style": "none",
	"border-right-style": "none",
	"border-bottom-style": "none",
	"border-left-style": "none",
};

/**
 * Curate the way a session does, with the initial values the
 * browser reported. Tests that care about their absence call
 * curateWithout directly.
 */
function curateStyles(
	styles: ComputedStyles,
	options: CurateOptions = {},
): ReturnType<typeof curateWithout> {
	return curateWithout(styles, { initials: INITIALS, ...options });
}

/** Read a group's entries as "property: value" for comparison. */
function group(
	groups: ReturnType<typeof curateStyles>,
	name: string,
): string[] {
	const found = groups.find((g) => g.name === name);
	return (found?.entries ?? []).map((e) => `${e.property}: ${e.value}`);
}

describe("curateStyles", () => {
	it("puts a layout property under box", () => {
		const groups = curateStyles({ display: "inline-block" });
		expect(group(groups, "box")).toContain("display: inline-block");
	});

	it("puts a text property under typography", () => {
		const groups = curateStyles({ "font-weight": "700" });
		expect(group(groups, "typography")).toContain("font-weight: 700");
	});

	it("puts a paint property under paint", () => {
		const groups = curateStyles({ "background-color": "rgb(0, 0, 255)" });
		expect(group(groups, "paint")).toContain(
			"background-color: rgb(0, 0, 255)",
		);
	});

	it("leaves out a property sitting at its initial value", () => {
		// A page has hundreds of these. They explain nothing about
		// why the element looks the way it does.
		const groups = curateStyles({ position: "static", display: "flex" });
		expect(group(groups, "box")).toEqual(["display: flex"]);
	});

	it("keeps a property that was actually changed", () => {
		const groups = curateStyles({ position: "absolute" });
		expect(group(groups, "box")).toContain("position: absolute");
	});

	it("leaves out properties nobody asked about", () => {
		// The capture carries hundreds of properties; the curated
		// set is the ones that explain appearance and layout.
		const groups = curateStyles({ "-webkit-font-smoothing": "antialiased" });
		expect(groups).toEqual([]);
	});

	it("drops a group that ended up with nothing in it", () => {
		const groups = curateStyles({ display: "flex" });
		expect(groups.map((g) => g.name)).toEqual(["box"]);
	});

	it("orders groups so the reading starts with layout", () => {
		const groups = curateStyles({
			color: "rgb(1, 2, 3)",
			display: "flex",
			"font-size": "20px",
		});
		expect(groups.map((g) => g.name)).toEqual(["box", "typography", "paint"]);
	});

	it("returns exactly the properties asked for, when asked", () => {
		// An explicit request overrides curation entirely: the
		// caller knows something the curated set does not.
		const groups = curateStyles(
			{ "-webkit-font-smoothing": "antialiased", display: "flex" },
			{ only: ["-webkit-font-smoothing"] },
		);
		expect(groups).toEqual([
			{
				name: "requested",
				entries: [{ property: "-webkit-font-smoothing", value: "antialiased" }],
			},
		]);
	});

	it("keeps a requested property even at its initial value", () => {
		const groups = curateStyles({ position: "static" }, { only: ["position"] });
		expect(group(groups, "requested")).toEqual(["position: static"]);
	});

	it("says nothing about a requested property the capture lacks", () => {
		const groups = curateStyles({ display: "flex" }, { only: ["rotate"] });
		expect(groups).toEqual([]);
	});

	it("keeps the initial values too when asked for everything", () => {
		const groups = curateStyles(
			{ display: "flex", position: "static" },
			{ all: true },
		);
		expect(group(groups, "box")).toEqual(["display: flex", "position: static"]);
	});

	it("uses the shorthand the browser serialized", () => {
		// Chrome writes "1px 2px" itself. Recomputing that here
		// would be reimplementing CSS serialization and inviting it
		// to drift from what the browser actually means.
		const groups = curateStyles({
			padding: "1px 2px",
			"padding-bottom": "1px",
			"padding-left": "2px",
			"padding-right": "2px",
			"padding-top": "1px",
		});
		expect(group(groups, "box")).toEqual(["padding: 1px 2px"]);
	});

	it("leaves the sides as reported when no shorthand was captured", () => {
		// A foreign capture may carry longhands only. Inventing the
		// shorthand would be guessing at the browser's serialization.
		const groups = curateStyles({
			"padding-bottom": "1px",
			"padding-left": "2px",
			"padding-right": "2px",
			"padding-top": "1px",
		});
		expect(group(groups, "box")).toEqual([
			"padding-top: 1px",
			"padding-right: 2px",
			"padding-bottom: 1px",
			"padding-left: 2px",
		]);
	});

	it("leaves out a shorthand sitting at its initial value", () => {
		const groups = curateStyles({ margin: "0px", padding: "1px 2px" });
		expect(group(groups, "box")).toEqual(["padding: 1px 2px"]);
	});

	it("keeps a shorthand whose sides disagree", () => {
		// The browser writes the uneven case out in full, and that
		// is a real border on one side only.
		const groups = curateStyles({
			"border-style": "solid none none",
			"border-width": "2px 0px 0px",
		});
		expect(group(groups, "box")).toContain("border-width: 2px 0px 0px");
		expect(group(groups, "paint")).toContain("border-style: solid none none");
	});

	it("leaves out a border colour when there is no border", () => {
		// Chrome reports a colour for every side whether or not a
		// border is drawn. Reporting it invites a reader to explain
		// an appearance by a property that paints nothing.
		const groups = curateStyles({
			"border-top-color": "rgb(0, 0, 0)",
			"border-top-style": "none",
			"border-top-width": "0px",
		});
		expect(groups).toEqual([]);
	});

	it("keeps a border colour when a border is actually drawn", () => {
		const groups = curateStyles({
			"border-top-color": "rgb(0, 0, 0)",
			"border-top-style": "solid",
			"border-top-width": "2px",
		});
		expect(group(groups, "paint")).toContain("border-top-color: rgb(0, 0, 0)");
	});

	it("judges each border side on its own", () => {
		const groups = curateStyles({
			"border-left-color": "rgb(9, 9, 9)",
			"border-left-style": "none",
			"border-left-width": "0px",
			"border-top-color": "rgb(1, 1, 1)",
			"border-top-style": "solid",
			"border-top-width": "2px",
		});
		expect(group(groups, "paint")).toEqual([
			"border-top-style: solid",
			"border-top-color: rgb(1, 1, 1)",
		]);
	});

	it("leaves out an outline width when no outline is drawn", () => {
		// Chrome computes the focus ring width even at rest, so this
		// one reads as a real 3px outline that is not there.
		const groups = curateStyles({
			"outline-color": "rgb(0, 0, 0)",
			"outline-style": "none",
			"outline-width": "3px",
		});
		expect(groups).toEqual([]);
	});

	it("keeps an outline width somebody chose", () => {
		const groups = curateStyles({
			"outline-color": "rgb(0, 0, 255)",
			"outline-style": "solid",
			"outline-width": "5px",
		});
		expect(group(groups, "paint")).toContain("outline-width: 5px");
	});

	it("leaves out a transform origin when nothing is transformed", () => {
		// Chrome resolves the 50% 50% initial into pixels, so it
		// never matches its own initial value.
		const groups = curateStyles({
			transform: "none",
			"transform-origin": "392px 18.5px",
		});
		expect(groups).toEqual([]);
	});

	it("keeps the transform origin once something is transformed", () => {
		const groups = curateStyles({
			transform: "scale(2)",
			"transform-origin": "392px 18.5px",
		});
		expect(group(groups, "motion")).toEqual([
			"transform: scale(2)",
			"transform-origin: 392px 18.5px",
		]);
	});

	it("still returns an ineffective property when asked for it", () => {
		// Suppression is a presentation default, not a ceiling.
		const groups = curateStyles(
			{ "border-top-color": "rgb(0, 0, 0)", "border-top-style": "none" },
			{ only: ["border-top-color"] },
		);
		expect(group(groups, "requested")).toEqual([
			"border-top-color: rgb(0, 0, 0)",
		]);
	});

	it("still returns ineffective properties under all", () => {
		const groups = curateStyles(
			{ transform: "none", "transform-origin": "392px 18.5px" },
			{ all: true },
		);
		expect(group(groups, "motion")).toContain("transform-origin: 392px 18.5px");
	});

	it("suppresses nothing when nobody said what the defaults are", () => {
		// Without the browser's initial values there is no honest
		// way to know that static means untouched, and guessing is
		// what the hand-kept table did wrong.
		const groups = curateWithout({ position: "static", display: "flex" });
		expect(groups.flatMap((g) => g.entries.map((e) => e.property))).toEqual([
			"display",
			"position",
		]);
	});

	it("treats the browser's outline-width initial as untouched", () => {
		// Chrome's initial outline-width is 3px, not 0px. A table
		// kept by hand had this wrong and only looked right because
		// another rule happened to hide it.
		const groups = curateStyles({
			"outline-style": "solid",
			"outline-width": "3px",
		});
		expect(group(groups, "paint")).toEqual(["outline-style: solid"]);
	});

	it("orders entries within a group the same way every time", () => {
		// Two reads of an unchanged element must be diffable, so
		// the order follows the curated set, not the capture.
		const forwards = curateStyles({ height: "10px", width: "20px" });
		const backwards = curateStyles({ width: "20px", height: "10px" });
		expect(group(forwards, "box")).toEqual(group(backwards, "box"));
	});
});

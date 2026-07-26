/**
 * Layout rules.
 *
 * The numbers in these fixtures are read off a live capture of a
 * page with each fault planted deliberately, so a rule that
 * disagrees with the specification disagrees with a browser
 * rather than with a guess.
 */

import { describe, expect, it } from "vitest";
import {
	analyseVisual,
	brokenImages,
	clippedContent,
	distortedImages,
	escapedElements,
	horizontalOverflow,
	isVisuallyHidden,
	type PageBox,
	tinyText,
	type VisualNode,
} from "../../../../lib/web/audit/visual.js";

const VIEWPORT: PageBox = {
	width: 800,
	height: 600,
	documentWidth: 3064,
	documentHeight: 600,
};

const el = (over: Partial<VisualNode> & { id: string }): VisualNode => ({
	selector: `.${over.id}`,
	tag: "div",
	rect: { x: 0, y: 0, width: 100, height: 20 },
	scrollWidth: 100,
	scrollHeight: 20,
	clientWidth: 100,
	clientHeight: 20,
	overflowX: "visible",
	overflowY: "visible",
	fontSizePx: 16,
	clipPath: "none",
	...over,
});

describe("isVisuallyHidden", () => {
	it("knows the one pixel clip-path idiom", () => {
		// The modern screen-reader-only recipe, straight off a live
		// capture: 1 by 1 with clip-path inset(50%).
		expect(
			isVisuallyHidden(
				el({
					id: "sr",
					rect: { x: 387, y: 140, width: 1, height: 1 },
					clipPath: "inset(50%)",
					overflowX: "hidden",
					scrollWidth: 51,
					clientWidth: 1,
				}),
			),
		).toBe(true);
	});

	it("knows the older off-to-the-left idiom", () => {
		expect(
			isVisuallyHidden(
				el({ id: "off", rect: { x: -9999, y: 54, width: 240, height: 18 } }),
			),
		).toBe(true);
	});

	it("does not call ordinary content hidden", () => {
		expect(isVisuallyHidden(el({ id: "p" }))).toBe(false);
	});

	it("does not call a small visible box hidden", () => {
		// Two pixels wide but not clipped and not off-screen: that
		// is a rule or a spacer, and it is on the page.
		expect(
			isVisuallyHidden(
				el({ id: "hr", rect: { x: 0, y: 0, width: 2, height: 200 } }),
			),
		).toBe(false);
	});
});

describe("horizontalOverflow", () => {
	it("reports a page that scrolls sideways, and what is widest", () => {
		const [found] = horizontalOverflow(
			[el({ id: "wide", rect: { x: 0, y: 0, width: 2016, height: 34 } })],
			VIEWPORT,
		);
		expect(found?.rule).toBe("page-scrolls-sideways");
		expect(found?.nodes[0]?.messages[0]).toContain("2016");
	});

	it("says nothing when the document fits", () => {
		expect(
			horizontalOverflow([el({ id: "a" })], {
				...VIEWPORT,
				documentWidth: 800,
			}),
		).toEqual([]);
	});

	it("does not blame an element hidden off to the left", () => {
		const [found] = horizontalOverflow(
			[
				el({ id: "off", rect: { x: -9999, y: 0, width: 240, height: 18 } }),
				el({ id: "wide", rect: { x: 0, y: 0, width: 2016, height: 34 } }),
			],
			VIEWPORT,
		);
		expect(found?.nodes).toHaveLength(1);
		expect(found?.nodes[0]?.selector).toBe(".wide");
	});

	it("still reports the overflow when no one element explains it", () => {
		const [found] = horizontalOverflow([el({ id: "a" })], VIEWPORT);
		expect(found?.nodes[0]?.selector).toBe("document");
	});

	it("names only the worst few rather than everything wide", () => {
		const many = Array.from({ length: 20 }, (_, index) =>
			el({
				id: `w${index}`,
				rect: { x: 0, y: 0, width: 900 + index, height: 10 },
			}),
		);
		expect(horizontalOverflow(many, VIEWPORT)[0]?.nodes).toHaveLength(5);
	});
});

describe("clippedContent", () => {
	it("catches text cut off by an overflow hidden box", () => {
		// Live numbers: a 120 pixel box holding 421 pixels of text.
		const [found] = clippedContent([
			el({
				id: "clip",
				text: "This text is definitely too long for its box",
				rect: { x: 0, y: 34, width: 120, height: 20 },
				scrollWidth: 421,
				clientWidth: 120,
				overflowX: "hidden",
			}),
		]);
		expect(found?.rule).toBe("content-is-clipped");
		expect(found?.nodes[0]?.messages[0]).toContain("301 pixels wider");
	});

	it("does not report the screen-reader-only idiom", () => {
		// This is the false positive that would make the rule
		// worthless: every correct skip link on every page.
		expect(
			clippedContent([
				el({
					id: "sr",
					text: "Skip to content",
					rect: { x: 0, y: 0, width: 1, height: 1 },
					scrollWidth: 51,
					clientWidth: 1,
					overflowX: "hidden",
					clipPath: "inset(50%)",
				}),
			]),
		).toEqual([]);
	});

	it("leaves a scrollable box alone, since nothing is lost", () => {
		expect(
			clippedContent([
				el({
					id: "scroller",
					text: "long",
					scrollWidth: 900,
					clientWidth: 100,
					overflowX: "auto",
				}),
			]),
		).toEqual([]);
	});

	it("ignores an element with no text of its own", () => {
		expect(
			clippedContent([
				el({
					id: "box",
					scrollWidth: 900,
					clientWidth: 100,
					overflowX: "hidden",
				}),
			]),
		).toEqual([]);
	});

	it("catches a vertical cut as well as a horizontal one", () => {
		const [found] = clippedContent([
			el({
				id: "short",
				text: "a lot of text",
				scrollHeight: 200,
				clientHeight: 20,
				overflowY: "hidden",
			}),
		]);
		expect(found?.nodes[0]?.messages[0]).toContain("taller");
	});

	it("does not fire on a sub-pixel difference", () => {
		expect(
			clippedContent([
				el({
					id: "round",
					text: "x",
					scrollWidth: 100.4,
					clientWidth: 100,
					overflowX: "hidden",
				}),
			]),
		).toEqual([]);
	});
});

describe("escapedElements", () => {
	it("reports something parked past the right edge", () => {
		const [found] = escapedElements(
			[el({ id: "off", rect: { x: 3000, y: 54, width: 64, height: 90 } })],
			VIEWPORT,
		);
		expect(found?.nodes[0]?.messages[0]).toContain("x=3000");
	});

	it("leaves the off-to-the-left idiom alone", () => {
		// It hides content without extending the page, which is the
		// whole reason the idiom uses a negative offset.
		expect(
			escapedElements(
				[el({ id: "off", rect: { x: -9999, y: 0, width: 240, height: 18 } })],
				VIEWPORT,
			),
		).toEqual([]);
	});

	it("ignores an element with no size", () => {
		expect(
			escapedElements(
				[el({ id: "z", rect: { x: 3000, y: 0, width: 0, height: 0 } })],
				VIEWPORT,
			),
		).toEqual([]);
	});
});

describe("brokenImages", () => {
	it("catches an image the browser gave up on", () => {
		const [found] = brokenImages([
			el({
				id: "gone",
				tag: "img",
				src: "/does-not-exist.png",
				complete: true,
				naturalWidth: 0,
				naturalHeight: 0,
			}),
		]);
		expect(found?.nodes[0]?.messages[0]).toContain("did not load");
	});

	it("leaves an image that loaded alone", () => {
		expect(
			brokenImages([
				el({
					id: "ok",
					tag: "img",
					src: "/real.png",
					complete: true,
					naturalWidth: 64,
					naturalHeight: 64,
				}),
			]),
		).toEqual([]);
	});

	it("waits for one still loading rather than calling it broken", () => {
		expect(
			brokenImages([
				el({
					id: "slow",
					tag: "img",
					src: "/slow.png",
					complete: false,
					naturalWidth: 0,
				}),
			]),
		).toEqual([]);
	});
});

describe("distortedImages", () => {
	it("catches a square image drawn as a wide rectangle", () => {
		// Live numbers: a 64 by 64 source drawn at 200 by 40.
		const [found] = distortedImages([
			el({
				id: "stretched",
				tag: "img",
				rect: { x: 0, y: 164, width: 200, height: 40 },
				naturalWidth: 64,
				naturalHeight: 64,
			}),
		]);
		expect(found?.nodes[0]?.messages[0]).toContain("64 by 64");
	});

	it("is happy with an image drawn at its own shape", () => {
		expect(
			distortedImages([
				el({
					id: "ok",
					tag: "img",
					rect: { x: 0, y: 0, width: 64, height: 64 },
					naturalWidth: 64,
					naturalHeight: 64,
				}),
			]),
		).toEqual([]);
	});

	it("is happy with an image scaled evenly", () => {
		expect(
			distortedImages([
				el({
					id: "half",
					tag: "img",
					rect: { x: 0, y: 0, width: 32, height: 32 },
					naturalWidth: 64,
					naturalHeight: 64,
				}),
			]),
		).toEqual([]);
	});

	it("tolerates a small difference from rounding", () => {
		expect(
			distortedImages([
				el({
					id: "near",
					tag: "img",
					rect: { x: 0, y: 0, width: 65, height: 64 },
					naturalWidth: 64,
					naturalHeight: 64,
				}),
			]),
		).toEqual([]);
	});

	it("says nothing about an image that never loaded", () => {
		// That is the broken rule's business, and reporting it twice
		// helps nobody.
		expect(
			distortedImages([
				el({
					id: "gone",
					tag: "img",
					rect: { x: 0, y: 0, width: 200, height: 40 },
					naturalWidth: 0,
					naturalHeight: 0,
				}),
			]),
		).toEqual([]);
	});
});

describe("tinyText", () => {
	it("reports eight pixel text", () => {
		const [found] = tinyText([
			el({ id: "tiny", text: "Tiny text", fontSizePx: 8 }),
		]);
		expect(found?.nodes[0]?.messages[0]).toContain("8 pixels");
	});

	it("calls itself a judgment rather than a WCAG threshold", () => {
		const [found] = tinyText([el({ id: "t", text: "x", fontSizePx: 8 })]);
		expect(found?.help).toContain("judgment");
		expect(found?.authority).toBe("best-practice");
	});

	it("leaves ordinary text alone", () => {
		expect(tinyText([el({ id: "p", text: "Normal", fontSizePx: 16 })])).toEqual(
			[],
		);
	});
});

describe("analyseVisual", () => {
	it("runs every rule against one capture", () => {
		const rules = analyseVisual(
			[
				el({ id: "wide", rect: { x: 0, y: 0, width: 2016, height: 34 } }),
				el({
					id: "gone",
					tag: "img",
					src: "/x.png",
					complete: true,
					naturalWidth: 0,
				}),
				el({ id: "tiny", text: "small", fontSizePx: 8 }),
			],
			VIEWPORT,
		);
		expect([...rules.map((rule) => rule.rule)].sort()).toEqual([
			"image-loads",
			"page-scrolls-sideways",
			"text-is-legible",
		]);
	});

	it("says nothing about a page that lays out cleanly", () => {
		expect(
			analyseVisual([el({ id: "p", text: "Normal" })], {
				...VIEWPORT,
				documentWidth: 800,
			}),
		).toEqual([]);
	});
});

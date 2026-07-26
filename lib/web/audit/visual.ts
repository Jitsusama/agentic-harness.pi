/**
 * Rules about what the layout actually did.
 *
 * A visual linter earns its keep or loses it on false positives.
 * Every rule here reports only where the browser's own numbers
 * leave no room for argument, and two well-known deliberate
 * idioms are recognised rather than reported: content parked far
 * off to the left, and the one-pixel clipped box used to hide
 * text from sight but not from a screen reader. Flagging those
 * would train the reader to ignore the whole report.
 *
 * Where a judgment is presentational rather than measured, it
 * says so at the rule. Whether eight pixel text is too small is
 * an opinion; whether an image failed to load is not.
 */

import { HIDDEN_BOX_PX } from "../snapshot/presented.js";
import type { A11yFinding, FindingKind, FindingNode, Impact } from "./axe.js";

/**
 * The viewport WCAG 1.4.10 Reflow is specified at.
 *
 * The criterion asks that content reflow at 320 CSS pixels, so a
 * capture wider than this has not tested it and must not cite
 * it. A little headroom above 320 keeps a 375px phone capture,
 * the usual narrow case, inside the claim.
 */
export const REFLOW_WIDTH = 400;

/** One element as the layout rules need to see it. */
export interface VisualNode {
	readonly id: string;
	readonly selector: string;
	readonly tag: string;
	/** Position and size in the page, from the browser. */
	readonly rect: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
	/** What the content wants, against what the box gives it. */
	readonly scrollWidth: number;
	readonly scrollHeight: number;
	readonly clientWidth: number;
	readonly clientHeight: number;
	readonly overflowX: string;
	readonly overflowY: string;
	readonly fontSizePx: number;
	readonly clipPath: string;
	/** "ellipsis" when text is deliberately truncated with one. */
	readonly textOverflow?: string;
	/** A line count when the text is deliberately clamped. */
	readonly lineClamp?: string;
	/** How an image fills its box: cover and contain crop, they do not squash. */
	readonly objectFit?: string;
	/** An image's own dimensions, zero when it failed to load. */
	readonly naturalWidth?: number;
	readonly naturalHeight?: number;
	/** Whether the browser finished trying to load it. */
	readonly complete?: boolean;
	readonly src?: string;
	/** Text this element holds directly, trimmed. */
	readonly text?: string;
}

/**
 * The page as a whole, which some rules need.
 *
 * Named PageBox rather than Viewport because it carries the
 * document's full extent as well as the visible area, and
 * because a Viewport elsewhere in this library means only the
 * part a person can see.
 */
export interface PageBox {
	readonly width: number;
	readonly height: number;
	readonly documentWidth: number;
	readonly documentHeight: number;
	/**
	 * How far the page was scrolled when this was captured.
	 *
	 * Rects are recorded in document coordinates, and a screenshot
	 * is in viewport coordinates. Anything joining the two needs
	 * the offset between them, and without it a visual diff
	 * attributed its regions to whatever happened to sit at those
	 * coordinates at the top of the page.
	 */
	readonly scrollX?: number;
	readonly scrollY?: number;
}

/** Below this, text is hard to read for many people. */
export const SMALL_TEXT_PX = 10;

/** How far an image's shape may differ before it looks wrong. */
export const ASPECT_TOLERANCE = 0.1;

/**
 * A box no larger than this is a hiding technique, not content.
 *
 * Owned by the page-side module that embeds it into the probes, so
 * the threshold the browser is measured against and the one this
 * analysis judges by cannot drift apart. Re-exported here because
 * this is where consumers have always found it.
 */
export { HIDDEN_BOX_PX };

/** Slack for sub-pixel layout, so rounding is not a finding. */
const SUBPIXEL = 1;

/**
 * Assemble one finding.
 *
 * `kind` matters as much as `impact`. A rule that measures a
 * failure files a violation; a rule that reports a judgment
 * files needs-review, which counts as a warning rather than a
 * failure. Everything here used to be a violation, so a rule
 * whose own help text called itself a judgment and not a WCAG
 * threshold still failed the check on a single 9px disclaimer.
 *
 * A criterion is only ever cited when this module measured the
 * thing the criterion is about. Asserting one an auditor can
 * disprove costs more credibility than staying quiet.
 */
function make(
	rule: string,
	impact: Impact,
	help: string,
	nodes: readonly FindingNode[],
	criteria: readonly string[] = [],
	kind: FindingKind = "violation",
): A11yFinding[] {
	if (nodes.length === 0) return [];
	return [
		{
			rule,
			kind,
			impact,
			authority: criteria.length > 0 ? "wcag" : "best-practice",
			criteria,
			levels: criteria.length > 0 ? ["AA"] : [],
			help,
			nodes,
		},
	];
}

function at(node: VisualNode, message: string): FindingNode {
	return { selector: node.selector, html: "", messages: [message] };
}

/**
 * Whether the author asked for this text to be cut short.
 *
 * An ellipsis and a line clamp are promises, not accidents: they
 * say there is more and the author knows. Their computed
 * signature (content wider or taller than the box, overflow
 * hidden) is indistinguishable from a real amputation, so this
 * is the exception that decides whether the clipping rule is
 * usable or noise.
 *
 * Presentational recognition, like isVisuallyHidden below: the
 * browser has no notion of a deliberate idiom.
 */
function isDeliberatelyTruncated(node: VisualNode): boolean {
	if (node.textOverflow === "ellipsis") return true;
	const clamp = node.lineClamp;
	return clamp !== undefined && clamp !== "none" && clamp !== "";
}

/**
 * Whether an element is using a known way of hiding text from
 * sight while leaving it to a screen reader.
 *
 * This is pattern recognition, not measurement: the browser has
 * no notion of a visually-hidden idiom. It is here because the
 * alternative is reporting every correctly built skip link on
 * every page, which would make the clipping rule worthless.
 */
export function isVisuallyHidden(node: VisualNode): boolean {
	const tiny =
		node.rect.width <= HIDDEN_BOX_PX && node.rect.height <= HIDDEN_BOX_PX;
	if (tiny && node.clipPath !== "none") return true;
	if (tiny && node.overflowX === "hidden") return true;
	// The older idiom: parked far off to the left, where no
	// scrollable area is created in a left-to-right page.
	return node.rect.x + node.rect.width < 0;
}

/**
 * The page scrolls sideways.
 *
 * Almost always a mistake, and a serious one on a narrow screen,
 * where it makes every line of text require two-directional
 * scrolling to read.
 */
export function horizontalOverflow(
	nodes: readonly VisualNode[],
	viewport: PageBox,
): readonly A11yFinding[] {
	if (viewport.documentWidth <= viewport.width + SUBPIXEL) return [];

	const culprits = nodes
		.filter((node) => !isVisuallyHidden(node))
		.filter((node) => node.rect.x + node.rect.width > viewport.width + SUBPIXEL)
		.sort((a, b) => b.rect.x + b.rect.width - (a.rect.x + a.rect.width))
		.slice(0, 5)
		.map((node) =>
			at(
				node,
				`Reaches ${Math.round(node.rect.x + node.rect.width)} pixels ` +
					`across, past the ${viewport.width} pixel viewport.`,
			),
		);

	return make(
		"page-scrolls-sideways",
		"serious",
		`The page is ${Math.round(viewport.documentWidth)} pixels wide in a ` +
			`${viewport.width} pixel viewport, so it scrolls horizontally.`,
		culprits.length > 0
			? culprits
			: [
					{
						selector: "document",
						html: "",
						messages: ["Nothing single element accounts for the width."],
					},
				],
		// 1.4.10 Reflow is specified at a 320 CSS pixel viewport.
		// Citing it from a 1280px capture asserts a criterion that
		// was not tested; horizontal scrolling at a desktop width is
		// a real problem, just not that one.
		viewport.width <= REFLOW_WIDTH ? ["1.4.10"] : [],
	);
}

/**
 * Content cut off by the box it sits in.
 *
 * Measured, not guessed: the browser reports what the content
 * wanted and what the box gave it, and a difference with
 * overflow hidden means the rest is gone with no way to reach
 * it.
 */
export function clippedContent(
	nodes: readonly VisualNode[],
): readonly A11yFinding[] {
	const found = nodes
		.filter((node) => !isVisuallyHidden(node))
		.filter((node) => node.text)
		// Truncation that the author asked for is not lost content:
		// an ellipsis and a line clamp both say "there is more, and I
		// know". Their computed signature is identical to a real
		// amputation, so without excepting them this rule fires on
		// nearly every table cell, card title and breadcrumb on the
		// real web, at serious severity with a WCAG citation. A rule
		// that is red on every page gates nothing.
		.filter((node) => !isDeliberatelyTruncated(node))
		.filter((node) => {
			const cutX =
				node.scrollWidth > node.clientWidth + SUBPIXEL &&
				(node.overflowX === "hidden" || node.overflowX === "clip");
			const cutY =
				node.scrollHeight > node.clientHeight + SUBPIXEL &&
				(node.overflowY === "hidden" || node.overflowY === "clip");
			return cutX || cutY;
		})
		.map((node) => {
			const across = node.scrollWidth - node.clientWidth;
			const down = node.scrollHeight - node.clientHeight;
			const how =
				across > down
					? `${Math.round(across)} pixels wider than its box`
					: `${Math.round(down)} pixels taller than its box`;
			return at(node, `Content is ${how}, and the rest cannot be reached.`);
		});

	return make(
		"content-is-clipped",
		"serious",
		"Content is cut off by a box with overflow hidden. Nothing " +
			"scrolls it into view, so the remainder is simply lost.",
		found,
		// Not 1.4.4, which is about text resized to 200 percent and
		// is a thing this rule never does. The clipping is real and
		// worth reporting on its own terms.
		[],
	);
}

/**
 * Elements that escaped to the right of the document.
 *
 * Off to the left is the old way of hiding something, and does
 * not extend the page. Off to the right does, so it drags the
 * whole document wider and is nearly always an accident.
 */
export function escapedElements(
	nodes: readonly VisualNode[],
	viewport: PageBox,
): readonly A11yFinding[] {
	// Say it only when it is true. This rule asserts that an
	// element drags the page wider, and had no gate on whether the
	// page actually got wider, while the sibling rule above opens
	// with exactly that check. So a clipped carousel or an
	// off-canvas drawer, both of which live beyond the viewport by
	// design inside a clipping ancestor, were accused of widening
	// a document this module had already measured as viewport-wide.
	// The two rules contradicted each other inside one report.
	if (viewport.documentWidth <= viewport.width + SUBPIXEL) return [];

	const found = nodes
		.filter((node) => !isVisuallyHidden(node))
		.filter((node) => node.rect.width > 0 && node.rect.height > 0)
		.filter((node) => node.rect.x > viewport.width)
		.map((node) =>
			at(
				node,
				`Sits at x=${Math.round(node.rect.x)}, beyond the ` +
					`${viewport.width} pixel viewport, dragging the page wider.`,
			),
		);

	return make(
		"element-escaped-right",
		"moderate",
		"An element is positioned past the right of the viewport. Unlike " +
			"the off-to-the-left idiom, this extends the scrollable page.",
		found,
	);
}

/**
 * Images that did not load.
 *
 * The browser is unambiguous about this: it finished trying and
 * has no dimensions to show for it.
 */
export function brokenImages(
	nodes: readonly VisualNode[],
): readonly A11yFinding[] {
	const found = nodes
		.filter((node) => node.tag === "img" && node.src)
		.filter((node) => node.complete === true && node.naturalWidth === 0)
		.map((node) => at(node, `${node.src} did not load.`));

	return make(
		"image-loads",
		"serious",
		"An image failed to load. The browser finished trying and has no " +
			"dimensions for it.",
		found,
	);
}

/**
 * Images drawn at a shape they were not.
 *
 * Measured against the image's own dimensions, so this is a
 * comparison rather than an opinion; only the tolerance is
 * chosen.
 */
export function distortedImages(
	nodes: readonly VisualNode[],
): readonly A11yFinding[] {
	const found = nodes
		.filter((node) => node.tag === "img")
		// cover and contain crop or letterbox; they never distort a
		// pixel, so comparing drawn shape to source shape says
		// nothing about them. Without this the standard idiom for
		// every hero, avatar and thumbnail on the web reports as
		// squashed, at every width of a sweep. Only fill and
		// scale-down can actually change the shape.
		.filter(
			(node) =>
				node.objectFit === undefined ||
				node.objectFit === "fill" ||
				node.objectFit === "scale-down",
		)
		.filter(
			(node) =>
				(node.naturalWidth ?? 0) > 0 &&
				(node.naturalHeight ?? 0) > 0 &&
				node.rect.width > 0 &&
				node.rect.height > 0,
		)
		.flatMap((node) => {
			const natural = (node.naturalWidth ?? 1) / (node.naturalHeight ?? 1);
			const drawn = node.rect.width / node.rect.height;
			const drift = Math.abs(drawn - natural) / natural;
			if (drift <= ASPECT_TOLERANCE) return [];
			return [
				at(
					node,
					`Drawn at ${Math.round(node.rect.width)} by ` +
						`${Math.round(node.rect.height)} from a source that is ` +
						`${node.naturalWidth} by ${node.naturalHeight}, a ` +
						`${Math.round(drift * 100)} percent difference in shape.`,
				),
			];
		});

	return make(
		"image-keeps-its-shape",
		"moderate",
		"An image is drawn at a different shape from the file, so it is " +
			"squashed or stretched.",
		found,
	);
}

/**
 * Text below a readable size.
 *
 * Presentational judgment, and labelled as one. WCAG sets no
 * minimum font size, because it requires the page to survive
 * being zoomed instead. This is here because text this small is
 * usually an accident rather than a decision.
 */
export function tinyText(nodes: readonly VisualNode[]): readonly A11yFinding[] {
	const found = nodes
		.filter((node) => node.text && !isVisuallyHidden(node))
		.filter((node) => node.fontSizePx > 0 && node.fontSizePx < SMALL_TEXT_PX)
		.map((node) => at(node, `Set at ${node.fontSizePx} pixels.`));

	return make(
		"text-is-legible",
		"minor",
		`Text below ${SMALL_TEXT_PX} pixels. This is a judgment rather ` +
			"than a WCAG threshold, which asks instead that the page survive " +
			"being zoomed.",
		found,
		[],
		// Says of itself that it is an opinion, so it asks for a
		// person rather than declaring the page broken.
		"needs-review",
	);
}

/** Every layout rule, run against one capture. */
export function analyseVisual(
	nodes: readonly VisualNode[],
	viewport: PageBox,
): readonly A11yFinding[] {
	return [
		...horizontalOverflow(nodes, viewport),
		...clippedContent(nodes),
		...escapedElements(nodes, viewport),
		...brokenImages(nodes),
		...distortedImages(nodes),
		...tinyText(nodes),
	];
}

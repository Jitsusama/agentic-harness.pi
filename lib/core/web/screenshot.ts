/**
 * Bounded, tiled screenshot capture.
 *
 * `preparePage` settles the page (capture-width viewport, lazy-content
 * scroll) so every representation is read from one state. `captureTiles`
 * then captures the page as an ordered stack of vertical bands rather than
 * one full-page image. Each band stays under the model provider's image
 * dimension limit, so a long page can never produce an image the model
 * rejects. A page taller than the tile budget is truncated and the caller
 * is told.
 */

import type { Page } from "puppeteer-core";

/** A vertical slice of the page to capture, in page pixels. */
export interface TileBand {
	y: number;
	height: number;
}

/** An ordered set of clip bands covering a page, with a truncation flag. */
export interface TilePlan {
	bands: TileBand[];
	truncated: boolean;
}

/**
 * Plan the vertical clip bands that tile a page of the given height. No
 * band exceeds `bandHeight`, and the plan stops at `maxTiles`, reporting
 * `truncated` when the page runs past the tile budget.
 */
export function planTiles(
	pageHeight: number,
	opts: { bandHeight: number; maxTiles: number },
): TilePlan {
	const { bandHeight, maxTiles } = opts;
	const bands: TileBand[] = [];
	for (let y = 0; y < pageHeight && bands.length < maxTiles; y += bandHeight) {
		bands.push({ y, height: Math.min(bandHeight, pageHeight - y) });
	}
	const last = bands.at(-1);
	const covered = last ? last.y + last.height : 0;
	return { bands, truncated: covered < pageHeight };
}

/** Milliseconds to wait between scroll steps for lazy content to load. */
const SCROLL_STEP_WAIT = 100;

/** Maximum scroll steps before we give up and capture what we have. */
const MAX_SCROLL_STEPS = 40;

/**
 * Milliseconds to wait after resizing and scrolling for the reflow and
 * any scroll-triggered lazy loads to settle before capture.
 */
const SETTLE_WAIT = 500;

/**
 * Wait here rather than in the page. A page served with the CSP
 * sandbox directive runs no script, and to Chrome a timer's callback
 * is script, so a wait the page counted out itself never finished and
 * held its CDP call for the whole protocol timeout.
 */
function pause(ms: number): Promise<void> {
	return new Promise((wake) => setTimeout(wake, ms));
}

/**
 * Scroll to the bottom in viewport-sized steps to trigger lazy-loaded
 * content, then return to the top so the capture starts from the top.
 *
 * Each step is one synchronous evaluate and the pause between them is
 * counted here, so a page that runs no timers is scrolled all the same.
 */
async function scrollToBottom(page: Page): Promise<void> {
	for (let steps = 0; steps < MAX_SCROLL_STEPS; steps += 1) {
		await pause(SCROLL_STEP_WAIT);
		const moved = await page.evaluate(() => {
			const before = window.scrollY;
			window.scrollBy(0, window.innerHeight);
			return window.scrollY !== before;
		});
		if (!moved) break;
	}
	await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Fixed capture width in CSS pixels. Well under the provider's long-edge
 * downscale threshold, so width is never the offending dimension.
 */
const CAPTURE_WIDTH = 1280;

/**
 * Height of each tile in CSS pixels. Kept under the standard tier's
 * 1568-pixel long-edge limit so a tile is not downscaled and its text
 * stays legible.
 */
const BAND_HEIGHT = 1500;

/**
 * Ceiling on the number of tiles per page. Eight 1500-pixel bands cover
 * 12000 pixels of page while staying well under the 20-image request
 * rule, so a runaway page never floods the response.
 */
const MAX_TILES = 8;

/** A tiled capture: ordered base64 PNGs plus whether the page overran the budget. */
export interface TiledCapture {
	tiles: string[];
	truncated: boolean;
}

/**
 * Settle the page into the state every representation is captured from:
 * fix the viewport to the capture width, then scroll to the bottom so
 * lazy-loaded content renders, returning to the top. Call this once before
 * reading the DOM, inner text or screenshots so they all agree.
 */
export async function preparePage(page: Page): Promise<void> {
	// One band tall, so every band can be captured inside the viewport.
	await page.setViewport({ width: CAPTURE_WIDTH, height: BAND_HEIGHT });
	await scrollToBottom(page);
	// Let the resize reflow and any scroll-triggered lazy loads settle so
	// the text, DOM and screenshots that follow agree on one rendered state.
	await pause(SETTLE_WAIT);
}

/**
 * Capture the page as an ordered stack of PNG tiles, each a base64 string,
 * by clipping successive vertical bands planned by `planTiles`. No tile
 * exceeds the band height, and the capture stops at the tile ceiling.
 * Assumes `preparePage` has already settled the viewport and lazy content,
 * and has made the viewport one band tall.
 *
 * Each band is scrolled into the viewport and captured there. Capturing
 * beyond the viewport, which is what a clip does by default, has Chrome
 * lay out and paint the whole document for every tile whatever the clip:
 * measured on a 56767-pixel article, 67 seconds for a clip 100 pixels
 * tall, where the same band in the viewport took 0.07.
 *
 * Scrolling brings two differences with it, and both are undone so the
 * tiles show what a capture of the whole page showed. A fixed element
 * sits in the viewport, so it would be drawn into every tile, and a
 * cookie banner pinned to the bottom would cover the foot of each; fixed
 * elements are hidden after the first tile, so each is drawn once. A
 * sticky element would follow the scroll too, covering the top of each
 * later tile; sticky elements are put back where the flow places them
 * before any tile is taken, which moves nothing else, since a sticky box
 * takes the same space in the flow wherever it is drawn. The DOM and the
 * text were read before this, so none of it changes anything else the
 * reader returns.
 */
export async function captureTiles(page: Page): Promise<TiledCapture> {
	const pageHeight = await page.evaluate(() =>
		Math.ceil(document.documentElement.scrollHeight),
	);
	const { bands, truncated } = planTiles(pageHeight, {
		bandHeight: BAND_HEIGHT,
		maxTiles: MAX_TILES,
	});
	await page.evaluate(UNSTICK);
	const tiles: string[] = [];
	for (const [index, band] of bands.entries()) {
		if (index === 1) await page.evaluate(HIDE_FIXED);
		await page.evaluate((y) => window.scrollTo(0, y), band.y);
		const shot = await page.screenshot({
			type: "png",
			encoding: "base64",
			captureBeyondViewport: false,
			clip: { x: 0, y: band.y, width: CAPTURE_WIDTH, height: band.height },
		});
		tiles.push(
			typeof shot === "string" ? shot : Buffer.from(shot).toString("base64"),
		);
	}
	return { tiles, truncated };
}

/**
 * Page-side source: draw every sticky element where the flow puts it. A
 * relative box with no offsets is drawn exactly there, and like a sticky
 * one it still contains whatever is positioned inside it. A stylesheet
 * cannot select on computed position, so each element is asked. Setting
 * a style through the CSSOM is not something a page's content security
 * policy can refuse.
 */
const UNSTICK = `(() => {
	for (const el of document.querySelectorAll("body *")) {
		if (getComputedStyle(el).position === "sticky") {
			el.style.setProperty("position", "relative", "important");
			el.style.setProperty("inset", "auto", "important");
		}
	}
})()`;

/** Page-side source: hide every element the viewport pins in place. */
const HIDE_FIXED = `(() => {
	for (const el of document.querySelectorAll("body *")) {
		if (getComputedStyle(el).position === "fixed") {
			el.style.setProperty("visibility", "hidden", "important");
		}
	}
})()`;

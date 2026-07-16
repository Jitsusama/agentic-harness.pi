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
 * Scroll to the bottom in viewport-sized steps to trigger lazy-loaded
 * content, then return to the top so the capture starts from the top.
 */
async function scrollToBottom(page: Page): Promise<void> {
	await page.evaluate(
		({ wait, max }) =>
			new Promise<void>((resolve) => {
				let steps = 0;
				const timer = setInterval(() => {
					const before = window.scrollY;
					window.scrollBy(0, window.innerHeight);
					steps += 1;
					const reachedBottom = window.scrollY === before;
					if (steps >= max || reachedBottom) {
						clearInterval(timer);
						window.scrollTo(0, 0);
						resolve();
					}
				}, wait);
			}),
		{ wait: SCROLL_STEP_WAIT, max: MAX_SCROLL_STEPS },
	);
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
	await page.setViewport({ width: CAPTURE_WIDTH, height: 1024 });
	await scrollToBottom(page);
	// Let the resize reflow and any scroll-triggered lazy loads settle so
	// the text, DOM and screenshots that follow agree on one rendered state.
	await page.evaluate(
		(ms) => new Promise((r) => setTimeout(r, ms)),
		SETTLE_WAIT,
	);
}

/**
 * Capture the page as an ordered stack of PNG tiles, each a base64 string,
 * by clipping successive vertical bands planned by `planTiles`. No tile
 * exceeds the band height, and the capture stops at the tile ceiling.
 * Assumes `preparePage` has already settled the viewport and lazy content.
 */
export async function captureTiles(page: Page): Promise<TiledCapture> {
	const pageHeight = await page.evaluate(() =>
		Math.ceil(document.documentElement.scrollHeight),
	);
	const { bands, truncated } = planTiles(pageHeight, {
		bandHeight: BAND_HEIGHT,
		maxTiles: MAX_TILES,
	});
	const tiles: string[] = [];
	for (const band of bands) {
		const shot = await page.screenshot({
			type: "png",
			encoding: "base64",
			clip: { x: 0, y: band.y, width: CAPTURE_WIDTH, height: band.height },
		});
		tiles.push(
			typeof shot === "string" ? shot : Buffer.from(shot).toString("base64"),
		);
	}
	return { tiles, truncated };
}

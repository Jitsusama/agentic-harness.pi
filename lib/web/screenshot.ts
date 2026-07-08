/**
 * Full-page screenshot capture.
 *
 * Scrolls the page to the bottom first so lazy-loaded content renders,
 * then captures the whole page rather than just the viewport. Used as
 * the graceful fallback when text extraction fails: a page Readability
 * cannot parse returns a screenshot a vision model can read.
 */

import type { Page } from "puppeteer-core";

/** Milliseconds to wait between scroll steps for lazy content to load. */
const SCROLL_STEP_WAIT = 100;

/** Maximum scroll steps before we give up and capture what we have. */
const MAX_SCROLL_STEPS = 40;

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
 * Capture a full-page PNG screenshot as a base64 string, scrolling first
 * so lazy content is present in the capture.
 */
export async function captureFullPage(page: Page): Promise<string> {
	await scrollToBottom(page);
	const shot = await page.screenshot({
		fullPage: true,
		type: "png",
		encoding: "base64",
	});
	return typeof shot === "string" ? shot : Buffer.from(shot).toString("base64");
}

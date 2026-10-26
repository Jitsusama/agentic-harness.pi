/**
 * Article extraction runs beside the process rather than in it, so a
 * page that takes defuddle a minute cannot hold everything else still,
 * and it can be ended by a clock or a stop.
 */

import { describe, expect, it } from "vitest";
import {
	ARTICLE_WALL_MS,
	extractArticle,
} from "../../../lib/core/web/article.ts";

/** A page defuddle takes a few seconds over, since its cost grows with the square of the page. */
function heavyPage(paragraphs = 2_000): string {
	const body: string[] = [];
	for (let i = 0; i < paragraphs; i++) {
		body.push(
			`<div class="c${i % 50}"><p>Paragraph ${i} with <a href="/x/${i}">a link</a> and some words to read about the thing at hand.</p></div>`,
		);
	}
	return `<html><head><title>Heavy</title></head><body><article>${body.join("")}</article></body></html>`;
}

const article = `<html><head><title>On Clocks</title></head><body>
<nav><a href="/">Home</a></nav>
<article><h1>On Clocks</h1>
<p>${"A clock bounds every wait so nothing holds the session for good. ".repeat(8)}</p>
<p>Read <a href="/more">more about clocks</a> here.</p></article></body></html>`;

/** The longest the event loop went without running, while `work` was under way. */
async function longestStall<T>(
	work: Promise<T>,
): Promise<{ value: T; stall: number }> {
	let stall = 0;
	let last = performance.now();
	const tick = setInterval(() => {
		const now = performance.now();
		stall = Math.max(stall, now - last);
		last = now;
	}, 5);
	try {
		const value = await work;
		return { value, stall: Math.max(stall, performance.now() - last) };
	} finally {
		clearInterval(tick);
	}
}

// Each extraction may take its whole wall, which is longer than the test
// runner's default clock, and the first in a worker loads the DOM library
// cold: under a loaded full suite that alone ran past five seconds.
describe("extractArticle", { timeout: ARTICLE_WALL_MS + 10_000 }, () => {
	it("extracts the main content as markdown, with links against the page's address", async () => {
		const found = await extractArticle(article, "https://example.com/posts/1");
		expect(found?.title).toBe("On Clocks");
		expect(found?.wordCount).toBeGreaterThan(30);
		expect(found?.markdown).toContain("https://example.com/more");
		expect(found?.markdown).not.toContain("Home");
	});

	it("finds no article on a page with too little to read", async () => {
		const found = await extractArticle(
			"<html><body><p>Hello there.</p></body></html>",
			"https://example.com/",
		);
		expect(found).toBeNull();
	});

	it("leaves the event loop free while a heavy page is extracted", async () => {
		// About a second on the main thread, four times the stall allowed,
		// and a clock of its own: under a loaded full suite the default
		// one ran out on a heavier page and this read as a failure.
		const { value, stall } = await longestStall(
			extractArticle(heavyPage(800), "https://example.com/", {
				wallMs: 50_000,
			}),
		);
		expect(value?.wordCount).toBeGreaterThan(1_000);
		expect(stall).toBeLessThan(250);
	}, 60_000);

	it("gives up on a page that outlasts its clock, finding no article", async () => {
		const started = performance.now();
		const found = await extractArticle(heavyPage(), "https://example.com/", {
			wallMs: 300,
		});
		expect(found).toBeNull();
		expect(performance.now() - started).toBeLessThan(1_500);
	}, 60_000);

	it("gives up when stopped, finding no article", async () => {
		const stop = new AbortController();
		setTimeout(() => stop.abort(), 300);
		const started = performance.now();
		const found = await extractArticle(heavyPage(), "https://example.com/", {
			signal: stop.signal,
		});
		expect(found).toBeNull();
		expect(performance.now() - started).toBeLessThan(1_500);
	}, 60_000);

	it("does not start at all once already stopped", async () => {
		const stop = new AbortController();
		stop.abort();
		const started = performance.now();
		const found = await extractArticle(article, "https://example.com/", {
			signal: stop.signal,
		});
		expect(found).toBeNull();
		expect(performance.now() - started).toBeLessThan(50);
	});

	it("allows a real page far longer than a normal extraction takes", () => {
		expect(ARTICLE_WALL_MS).toBeGreaterThanOrEqual(10_000);
		expect(ARTICLE_WALL_MS).toBeLessThanOrEqual(30_000);
	});
});

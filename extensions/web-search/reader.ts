/**
 * Page reader — fetches a URL with headless Chrome and extracts
 * readable content using Mozilla Readability.
 */

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { newPage } from "./browser.js";

export interface PageContent {
	title: string;
	url: string;
	content: string;
	excerpt: string;
	length: number;
}

/**
 * Maximum characters to return. Pages can be enormous; we truncate
 * to avoid blowing up the context window.
 */
const MAX_CONTENT_LENGTH = 30_000;

export async function readPage(
	url: string,
	signal?: AbortSignal,
): Promise<PageContent> {
	const page = await newPage();
	try {
		if (signal?.aborted) throw new Error("Aborted");

		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

		if (signal?.aborted) throw new Error("Aborted");

		// Wait briefly for dynamic content
		await page.evaluate(
			() => new Promise((r) => setTimeout(r, 1500)),
		);

		const html = await page.content();
		const dom = new JSDOM(html, { url });
		const reader = new Readability(dom.window.document);
		const article = reader.parse();

		if (!article) {
			// Fallback: grab body text directly
			const bodyText = await page.evaluate(
				() => document.body?.innerText || "",
			);
			return {
				title: await page.title(),
				url,
				content: bodyText.slice(0, MAX_CONTENT_LENGTH),
				excerpt: bodyText.slice(0, 200),
				length: bodyText.length,
			};
		}

		const content =
			article.textContent.length > MAX_CONTENT_LENGTH
				? article.textContent.slice(0, MAX_CONTENT_LENGTH) +
					"\n\n[truncated]"
				: article.textContent;

		return {
			title: article.title,
			url,
			content,
			excerpt: article.excerpt || article.textContent.slice(0, 200),
			length: article.textContent.length,
		};
	} finally {
		await page.close();
	}
}

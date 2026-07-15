import { describe, expect, it } from "vitest";
import { formatManifest } from "../../../extensions/web-search-integration/manifest.js";
import type { PageBundle } from "../../../lib/web/reader.js";

const base: PageBundle = {
	title: "Support ticket #4563908",
	url: "https://support.github.com/ticket/enterprise/287/4563908",
	excerpt: "GitHub mirror throttling on shop/world.",
	dir: "/tmp/pi-web-read/abc123",
	articlePath: "/tmp/pi-web-read/abc123/article.md",
	innerTextPath: "/tmp/pi-web-read/abc123/innertext.txt",
	domPath: "/tmp/pi-web-read/abc123/dom.html",
	screenshotPaths: [
		"/tmp/pi-web-read/abc123/shot-01.png",
		"/tmp/pi-web-read/abc123/shot-02.png",
		"/tmp/pi-web-read/abc123/shot-03.png",
	],
	truncated: false,
};

describe("formatManifest", () => {
	it("names the page and carries the excerpt", () => {
		const out = formatManifest(base);
		expect(out).toContain("Support ticket #4563908");
		expect(out).toContain(base.url);
		expect(out).toContain("GitHub mirror throttling on shop/world.");
	});

	it("points at every representation, including each screenshot tile", () => {
		const out = formatManifest(base);
		expect(out).toContain(base.articlePath as string);
		expect(out).toContain(base.innerTextPath as string);
		expect(out).toContain(base.domPath);
		for (const tile of base.screenshotPaths) {
			expect(out).toContain(tile);
		}
	});

	it("omits the article line when extraction produced no article", () => {
		const out = formatManifest({ ...base, articlePath: undefined });
		expect(out).not.toContain("article.md");
		expect(out).toContain("innertext.txt");
	});

	it("adds a truncation note when the page overran the tile budget", () => {
		const out = formatManifest({ ...base, truncated: true });
		expect(out.toLowerCase()).toContain("truncat");
	});

	it("omits the screenshot section when there are no tiles", () => {
		const out = formatManifest({ ...base, screenshotPaths: [] });
		expect(out).not.toContain("shot-01.png");
	});
});

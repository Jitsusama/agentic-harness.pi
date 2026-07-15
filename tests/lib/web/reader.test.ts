import { describe, expect, it } from "vitest";
import { formatManifest, type PageBundle } from "../../../lib/web/reader.js";

const base: PageBundle = {
	title: "Support ticket #4563908",
	url: "https://support.github.com/ticket/enterprise/287/4563908",
	excerpt: "GitHub mirror throttling on shop/world.",
	dir: "/tmp/pi-web-read/abc123",
	article: "/tmp/pi-web-read/abc123/article.md",
	innertext: "/tmp/pi-web-read/abc123/innertext.txt",
	dom: "/tmp/pi-web-read/abc123/dom.html",
	screenshots: [
		"/tmp/pi-web-read/abc123/shot-01.png",
		"/tmp/pi-web-read/abc123/shot-02.png",
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

	it("points at every representation so the model can pick and choose", () => {
		const out = formatManifest(base);
		expect(out).toContain(base.article as string);
		expect(out).toContain(base.innertext as string);
		expect(out).toContain(base.dom as string);
		expect(out).toContain("shot-01.png");
		expect(out).toContain("shot-02.png");
	});

	it("reports the screenshot tile count", () => {
		const out = formatManifest(base);
		expect(out).toContain("2");
	});

	it("omits the article line when extraction produced no article", () => {
		const out = formatManifest({ ...base, article: undefined });
		expect(out).not.toContain("article.md");
		// The other representations are still offered.
		expect(out).toContain("innertext.txt");
	});

	it("adds a truncation note when the page overran the tile budget", () => {
		const out = formatManifest({ ...base, truncated: true });
		expect(out.toLowerCase()).toContain("truncat");
	});

	it("says so when there are no screenshots at all", () => {
		const plain = formatManifest({ ...base, screenshots: [] });
		expect(plain).not.toContain("shot-01.png");
	});
});

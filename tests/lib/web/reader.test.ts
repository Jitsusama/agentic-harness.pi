import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assembleBundle,
	type BundleSink,
	type Captured,
	diskSink,
	reapStaleBundles,
} from "../../../lib/web/reader.js";

/** A sink that records every write instead of touching disk. */
function fakeSink(): BundleSink & {
	texts: Map<string, string>;
	binaries: Map<string, string>;
} {
	const texts = new Map<string, string>();
	const binaries = new Map<string, string>();
	return {
		dir: "/tmp/pi-web-read/fake",
		texts,
		binaries,
		writeText(name, content) {
			texts.set(name, content);
			return `/tmp/pi-web-read/fake/${name}`;
		},
		writeBinary(name, base64) {
			binaries.set(name, base64);
			return `/tmp/pi-web-read/fake/${name}`;
		},
	};
}

const captured: Captured = {
	url: "https://example.com/article",
	title: "An Example Article",
	html: "<html><body><h1>Hi</h1></body></html>",
	innerText: "Hi\n\nsome body text",
	article: {
		markdown: "# Hi\n\nsome body text",
		title: "An Example Article",
		wordCount: 40,
	},
	tiles: ["QUJD", "REVG", "R0hJ"],
	truncated: false,
};

describe("assembleBundle", () => {
	it("always writes the DOM and returns a required domPath", () => {
		const sink = fakeSink();
		const bundle = assembleBundle(captured, sink);
		expect(sink.texts.get("dom.html")).toBe(captured.html);
		expect(bundle.domPath).toBe("/tmp/pi-web-read/fake/dom.html");
	});

	it("writes the article and inner text when present", () => {
		const sink = fakeSink();
		const bundle = assembleBundle(captured, sink);
		expect(sink.texts.has("article.md")).toBe(true);
		expect(bundle.articlePath).toBe("/tmp/pi-web-read/fake/article.md");
		expect(bundle.innerTextPath).toBe("/tmp/pi-web-read/fake/innertext.txt");
	});

	it("omits the article when extraction found none", () => {
		const sink = fakeSink();
		const bundle = assembleBundle({ ...captured, article: null }, sink);
		expect(sink.texts.has("article.md")).toBe(false);
		expect(bundle.articlePath).toBeUndefined();
	});

	it("writes every screenshot tile with a zero-padded ordered name", () => {
		const sink = fakeSink();
		const bundle = assembleBundle(captured, sink);
		expect([...sink.binaries.keys()]).toEqual([
			"shot-01.png",
			"shot-02.png",
			"shot-03.png",
		]);
		expect(bundle.screenshotPaths).toHaveLength(3);
	});

	it("writes the full content without silently truncating", () => {
		const sink = fakeSink();
		const huge = "x".repeat(500_000);
		assembleBundle({ ...captured, html: huge }, sink);
		expect(sink.texts.get("dom.html")).toHaveLength(500_000);
	});

	it("bounds a pathological page-controlled title", () => {
		const sink = fakeSink();
		const bundle = assembleBundle(
			{ ...captured, title: "T".repeat(10_000) },
			sink,
		);
		expect(bundle.title.length).toBeLessThan(1_000);
	});

	it("reports the final URL and truncation flag", () => {
		const sink = fakeSink();
		const bundle = assembleBundle({ ...captured, truncated: true }, sink);
		expect(bundle.url).toBe("https://example.com/article");
		expect(bundle.truncated).toBe(true);
	});
});

describe("diskSink", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-read-test-"));
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("creates the bundle directory inside the root, not as a sibling", () => {
		const sink = diskSink(root);
		expect(path.dirname(sink.dir)).toBe(root);
	});

	it("writes artifacts with owner-only permissions", () => {
		const sink = diskSink(root);
		const filePath = sink.writeText("dom.html", "<html></html>");
		expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
		expect(fs.statSync(sink.dir).mode & 0o777).toBe(0o700);
		expect(fs.readFileSync(filePath, "utf-8")).toBe("<html></html>");
	});

	it("round-trips a binary artifact from base64", () => {
		const sink = diskSink(root);
		const filePath = sink.writeBinary(
			"shot-01.png",
			Buffer.from("PNG").toString("base64"),
		);
		expect(fs.readFileSync(filePath).toString()).toBe("PNG");
	});
});

describe("reapStaleBundles", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-read-reap-"));
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("removes directories older than the max age and keeps fresh ones", () => {
		const now = 1_000_000_000_000;
		const stale = path.join(root, "r-stale");
		const fresh = path.join(root, "r-fresh");
		fs.mkdirSync(stale);
		fs.mkdirSync(fresh);
		fs.utimesSync(stale, new Date(now - 10_000), new Date(now - 10_000));
		fs.utimesSync(fresh, new Date(now - 1_000), new Date(now - 1_000));
		reapStaleBundles(5_000, now, root);
		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
	});

	it("does nothing when the root does not exist", () => {
		expect(() =>
			reapStaleBundles(5_000, Date.now(), path.join(root, "missing")),
		).not.toThrow();
	});
});

import { describe, expect, it } from "vitest";
import {
	extractBingUrl,
	extractDuckDuckGoUrl,
	firstProviderResults,
	type SearchResult,
} from "../../../lib/web/search.js";

const PROVIDER_A = { name: "a" } as never;
const PROVIDER_B = { name: "b" } as never;
const hit: SearchResult = { title: "t", url: "u", snippet: "s" };

describe("firstProviderResults", () => {
	it("returns the first provider that yields results", async () => {
		const tried: string[] = [];
		const out = await firstProviderResults(
			[PROVIDER_A, PROVIDER_B],
			async (p) => {
				tried.push((p as { name: string }).name);
				return [hit];
			},
		);
		expect(out).toEqual([hit]);
		expect(tried).toEqual(["a"]);
	});

	it("falls through an empty provider to the next", async () => {
		const tried: string[] = [];
		const out = await firstProviderResults(
			[PROVIDER_A, PROVIDER_B],
			async (p) => {
				const name = (p as { name: string }).name;
				tried.push(name);
				return name === "a" ? [] : [hit];
			},
		);
		expect(out).toEqual([hit]);
		expect(tried).toEqual(["a", "b"]);
	});

	it("falls through a throwing provider to the next", async () => {
		const out = await firstProviderResults(
			[PROVIDER_A, PROVIDER_B],
			async (p) => {
				if ((p as { name: string }).name === "a") throw new Error("boom");
				return [hit];
			},
		);
		expect(out).toEqual([hit]);
	});

	it("returns empty when every provider is empty", async () => {
		const out = await firstProviderResults(
			[PROVIDER_A, PROVIDER_B],
			async () => [],
		);
		expect(out).toEqual([]);
	});
});

/** Build a base64url string the way Bing encodes its `u` param. */
function toBase64Url(value: string): string {
	return Buffer.from(value, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

describe("extractDuckDuckGoUrl", () => {
	it("unwraps a uddg redirect to its destination", () => {
		const target = "https://example.com/some/path?a=1&b=2";
		const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`;
		expect(extractDuckDuckGoUrl(href)).toBe(target);
	});

	it("promotes a protocol-relative href to https", () => {
		expect(extractDuckDuckGoUrl("//example.com/x")).toBe(
			"https://example.com/x",
		);
	});

	it("returns a plain href unchanged", () => {
		expect(extractDuckDuckGoUrl("https://example.com/x")).toBe(
			"https://example.com/x",
		);
	});
});

describe("extractBingUrl", () => {
	it("decodes a ck/a redirect's base64url destination", () => {
		const target = "https://www.shopify.com/ca/store-login";
		const href = `https://www.bing.com/ck/a?!&&p=abc&u=a1${toBase64Url(target)}`;
		expect(extractBingUrl(href)).toBe(target);
	});

	it("returns a direct href unchanged", () => {
		expect(extractBingUrl("https://example.com/x")).toBe(
			"https://example.com/x",
		);
	});

	it("falls back to the raw href when the payload is not a URL", () => {
		const href = `https://www.bing.com/ck/a?u=a1${toBase64Url("not a url")}`;
		expect(extractBingUrl(href)).toBe(href);
	});
});

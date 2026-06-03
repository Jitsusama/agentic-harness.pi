import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearRefTypes,
	getRefType,
	listRefTypes,
	parseAllRefs,
	parseRef,
	type RefType,
	registerBuiltinRefTypes,
	registerRefType,
	unregisterRefType,
	urlForRef,
} from "../../../lib/refs/index";

beforeEach(() => clearRefTypes());
afterEach(() => clearRefTypes());

describe("registration", () => {
	const fake: RefType = {
		type: "fake",
		matchAll() {
			return [];
		},
	};

	it("registers and retrieves a ref type", () => {
		registerRefType(fake);
		expect(getRefType("fake")).toBe(fake);
		expect(listRefTypes()).toEqual([fake]);
	});

	it("overwrites an existing type with the same identifier", () => {
		const v1: RefType = { type: "fake", matchAll: () => ["a"] };
		const v2: RefType = { type: "fake", matchAll: () => ["b"] };
		registerRefType(v1);
		registerRefType(v2);
		expect(getRefType("fake")).toBe(v2);
	});

	it("unregisters a type", () => {
		registerRefType(fake);
		unregisterRefType("fake");
		expect(getRefType("fake")).toBeUndefined();
		expect(listRefTypes()).toEqual([]);
	});

	it("unregister on a missing type is a no-op", () => {
		expect(() => unregisterRefType("missing")).not.toThrow();
	});

	it("registerBuiltinRefTypes seeds the canonical five", () => {
		registerBuiltinRefTypes();
		const identifiers = listRefTypes().map((rt) => rt.type);
		expect(identifiers).toEqual([
			"github-issue",
			"github-pr",
			"github-repo",
			"slack-message",
			"slack-thread",
		]);
	});

	it("clearRefTypes empties the registry", () => {
		registerBuiltinRefTypes();
		clearRefTypes();
		expect(listRefTypes()).toEqual([]);
	});
});

describe("github-issue", () => {
	beforeEach(() => registerBuiltinRefTypes());

	it("matches a /issues/ URL", () => {
		const issue = getRefType("github-issue");
		expect(
			issue?.matchAll("https://github.com/shop/world/issues/47281"),
		).toEqual(["shop/world#47281"]);
	});

	it("matches the bare owner/repo#N form", () => {
		const issue = getRefType("github-issue");
		expect(issue?.matchAll("see shop/world#47281 for context")).toEqual([
			"shop/world#47281",
		]);
	});

	it("does not double-match when the URL and bare form refer to the same issue", () => {
		// A URL contains the substring owner/repo, so the
		// bare regex could match again. The implementation
		// must dedupe within one call.
		const issue = getRefType("github-issue");
		expect(
			issue?.matchAll(
				"see https://github.com/shop/world/issues/47281 and shop/world#47281",
			),
		).toEqual(["shop/world#47281"]);
	});

	it("builds a URL from a canonical value", () => {
		const issue = getRefType("github-issue");
		expect(issue?.url?.("shop/world#47281")).toBe(
			"https://github.com/shop/world/issues/47281",
		);
	});

	it("returns undefined for a malformed value", () => {
		const issue = getRefType("github-issue");
		expect(issue?.url?.("not-a-ref")).toBeUndefined();
	});
});

describe("github-pr", () => {
	beforeEach(() => registerBuiltinRefTypes());

	it("matches a /pull/ URL only", () => {
		const pr = getRefType("github-pr");
		expect(pr?.matchAll("https://github.com/shop/world/pull/47281")).toEqual([
			"shop/world#47281",
		]);
		expect(pr?.matchAll("https://github.com/shop/world/issues/47281")).toEqual(
			[],
		);
	});

	it("does not match the bare owner/repo#N form", () => {
		// We can't tell a bare ref apart from an issue.
		// PRs require the explicit /pull/ URL surface.
		const pr = getRefType("github-pr");
		expect(pr?.matchAll("shop/world#47281")).toEqual([]);
	});

	it("builds a /pull/ URL", () => {
		const pr = getRefType("github-pr");
		expect(pr?.url?.("shop/world#47281")).toBe(
			"https://github.com/shop/world/pull/47281",
		);
	});
});

describe("github-repo", () => {
	beforeEach(() => registerBuiltinRefTypes());

	it("matches a bare repo URL", () => {
		const repo = getRefType("github-repo");
		expect(repo?.matchAll("https://github.com/shop/world")).toEqual([
			"shop/world",
		]);
	});

	it("does not match a URL with further path components", () => {
		const repo = getRefType("github-repo");
		expect(
			repo?.matchAll("https://github.com/shop/world/issues/47281"),
		).toEqual([]);
	});

	it("builds a repo URL", () => {
		const repo = getRefType("github-repo");
		expect(repo?.url?.("shop/world")).toBe("https://github.com/shop/world");
	});
});

describe("slack-message", () => {
	beforeEach(() => registerBuiltinRefTypes());

	it("matches an archive URL without thread_ts", () => {
		const msg = getRefType("slack-message");
		expect(
			msg?.matchAll(
				"https://shopify.slack.com/archives/C0AJY0FLK8Q/p1778683833000200",
			),
		).toEqual(["shopify/C0AJY0FLK8Q/p1778683833000200"]);
	});

	it("ignores an archive URL that carries thread_ts", () => {
		const msg = getRefType("slack-message");
		expect(
			msg?.matchAll(
				"https://shopify.slack.com/archives/C0AJY0FLK8Q/p1778683935600300?thread_ts=1778683833.000200&cid=C0AJY0FLK8Q",
			),
		).toEqual([]);
	});

	it("builds an archive URL", () => {
		const msg = getRefType("slack-message");
		expect(msg?.url?.("shopify/C0AJY0FLK8Q/p1778683833000200")).toBe(
			"https://shopify.slack.com/archives/C0AJY0FLK8Q/p1778683833000200",
		);
	});
});

describe("slack-thread", () => {
	beforeEach(() => registerBuiltinRefTypes());

	it("matches an archive URL with thread_ts and points at the parent", () => {
		const thread = getRefType("slack-thread");
		// The matched URL is a reply (p1778683935600300) but
		// the canonical value points at the thread parent
		// (thread_ts=1778683833.000200 → p1778683833000200).
		expect(
			thread?.matchAll(
				"https://shopify.slack.com/archives/C0AJY0FLK8Q/p1778683935600300?thread_ts=1778683833.000200&cid=C0AJY0FLK8Q",
			),
		).toEqual(["shopify/C0AJY0FLK8Q/p1778683833000200"]);
	});

	it("ignores an archive URL without thread_ts", () => {
		const thread = getRefType("slack-thread");
		expect(
			thread?.matchAll(
				"https://shopify.slack.com/archives/C0AJY0FLK8Q/p1778683833000200",
			),
		).toEqual([]);
	});
});

describe("parseRef and parseAllRefs", () => {
	beforeEach(() => registerBuiltinRefTypes());

	it("parseRef returns the first matching type", () => {
		expect(parseRef("https://github.com/shop/world/issues/47281")).toEqual({
			type: "github-issue",
			value: "shop/world#47281",
		});
	});

	it("parseRef returns undefined when nothing matches", () => {
		expect(parseRef("just plain prose")).toBeUndefined();
	});

	it("parseAllRefs returns every match across types in registration order", () => {
		const text = [
			"Look at https://github.com/shop/world/pull/47281",
			"and https://github.com/shop/runtime/issues/123",
			"plus https://shopify.slack.com/archives/C0AJY0FLK8Q/p1778683833000200",
		].join("\n");
		expect(parseAllRefs(text)).toEqual([
			{ type: "github-issue", value: "shop/runtime#123" },
			{ type: "github-pr", value: "shop/world#47281" },
			{ type: "slack-message", value: "shopify/C0AJY0FLK8Q/p1778683833000200" },
		]);
	});

	it("parseAllRefs deduplicates the same {type, value} pair", () => {
		const text =
			"see https://github.com/shop/world/issues/47281 and shop/world#47281";
		const refs = parseAllRefs(text);
		const issueMatches = refs.filter((r) => r.type === "github-issue");
		expect(issueMatches).toEqual([
			{ type: "github-issue", value: "shop/world#47281" },
		]);
	});
});

describe("urlForRef", () => {
	beforeEach(() => registerBuiltinRefTypes());

	it("builds a URL via the registered type", () => {
		expect(urlForRef({ type: "github-issue", value: "shop/world#47281" })).toBe(
			"https://github.com/shop/world/issues/47281",
		);
	});

	it("returns undefined for an unregistered type", () => {
		expect(urlForRef({ type: "made-up", value: "x" })).toBeUndefined();
	});

	it("returns undefined when the type has no url function", () => {
		registerRefType({ type: "no-url", matchAll: () => [] });
		expect(urlForRef({ type: "no-url", value: "x" })).toBeUndefined();
	});
});

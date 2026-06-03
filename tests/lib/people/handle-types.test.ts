import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get, list } from "../../../lib/internal/people/registry";
import {
	clearHandleTypes,
	type HandleType,
	registerBuiltinHandleTypes,
	registerHandleType,
	unregisterHandleType,
} from "../../../lib/people/index";

beforeEach(() => clearHandleTypes());
afterEach(() => clearHandleTypes());

describe("registration", () => {
	const fake: HandleType = { type: "fake", parse: () => undefined };

	it("registers and retrieves a handle type", () => {
		registerHandleType(fake);
		expect(get("fake")).toBe(fake);
	});

	it("unregisters a handle type", () => {
		registerHandleType(fake);
		unregisterHandleType("fake");
		expect(get("fake")).toBeUndefined();
	});

	it("registerBuiltinHandleTypes seeds slack, github, email", () => {
		registerBuiltinHandleTypes();
		expect(list().map((t) => t.type)).toEqual(["slack", "github", "email"]);
	});
});

describe("slack handle type", () => {
	beforeEach(() => registerBuiltinHandleTypes());

	it("parses bare handles to lowercase", () => {
		expect(get("slack")?.parse("Joel.Gerber")).toBe("joel.gerber");
	});

	it("strips a leading @", () => {
		expect(get("slack")?.parse("@joel.gerber")).toBe("joel.gerber");
	});

	it("preserves stable user IDs as-is", () => {
		expect(get("slack")?.parse("U08ME9KASG7")).toBe("U08ME9KASG7");
	});

	it("rejects empty input", () => {
		expect(get("slack")?.parse("@")).toBeUndefined();
		expect(get("slack")?.parse("")).toBeUndefined();
	});

	it("matchAll finds @handles and U-ids in prose", () => {
		const text = "Chao (@chao.duan) asked Joel (U08ME9KASG7) about @xiao.li.";
		expect(get("slack")?.matchAll?.(text)).toEqual([
			"U08ME9KASG7",
			"chao.duan",
			"xiao.li",
		]);
	});
});

describe("github handle type", () => {
	beforeEach(() => registerBuiltinHandleTypes());

	it("parses bare handles preserving case", () => {
		expect(get("github")?.parse("Jitsusama")).toBe("Jitsusama");
	});

	it("strips a leading @", () => {
		expect(get("github")?.parse("@Jitsusama")).toBe("Jitsusama");
	});

	it("rejects handles longer than the GitHub limit", () => {
		const longHandle = "a".repeat(40);
		expect(get("github")?.parse(longHandle)).toBeUndefined();
	});

	it("matchAll captures handles from github URLs", () => {
		const text =
			"see https://github.com/Jitsusama and https://github.com/shop/world";
		// The URL with two path segments points at a repo,
		// not a user; matchAll only captures bare user URLs.
		// (Disambiguation by trailing path: a slash with
		// another segment means repo.)
		const matches = get("github")?.matchAll?.(text) ?? [];
		expect(matches).toContain("Jitsusama");
	});

	it("builds a github profile URL", () => {
		expect(get("github")?.url?.("Jitsusama")).toBe(
			"https://github.com/Jitsusama",
		);
	});
});

describe("email handle type", () => {
	beforeEach(() => registerBuiltinHandleTypes());

	it("parses and lowercases an email", () => {
		expect(get("email")?.parse("Joel@Shopify.com")).toBe("joel@shopify.com");
	});

	it("rejects strings without a domain", () => {
		expect(get("email")?.parse("joel")).toBeUndefined();
		expect(get("email")?.parse("joel@")).toBeUndefined();
		expect(get("email")?.parse("@shopify.com")).toBeUndefined();
	});

	it("matchAll finds emails in prose", () => {
		const text = "Reach Joel at Joel.Gerber@shopify.com or chao@shopify.com.";
		expect(get("email")?.matchAll?.(text)).toEqual([
			"joel.gerber@shopify.com",
			"chao@shopify.com",
		]);
	});

	it("builds a mailto URL", () => {
		expect(get("email")?.url?.("joel@shopify.com")).toBe(
			"mailto:joel@shopify.com",
		);
	});
});

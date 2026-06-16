import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRefQuery } from "../../../extensions/quest-workflow/lookup";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";

beforeAll(() => registerBuiltinRefTypes());
afterAll(() => clearRefTypes());

describe("resolveRefQuery", () => {
	it("rewrites a GitHub PR URL to the canonical alias value and type", () => {
		const result = resolveRefQuery({
			query: "https://github.com/Shopify/world/pull/47281",
		});
		expect(result.query).toBe("Shopify/world#47281");
		expect(result.refType).toBe("github-pr");
	});

	it("leaves a plain-text query untouched", () => {
		const result = resolveRefQuery({ query: "repair the gate" });
		expect(result.query).toBe("repair the gate");
		expect(result.refType).toBeUndefined();
	});

	it("leaves a query-less params object untouched", () => {
		const result = resolveRefQuery({ kind: "quest" });
		expect(result.query).toBeUndefined();
		expect(result.refType).toBeUndefined();
	});
});

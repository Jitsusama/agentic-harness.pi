import { describe, expect, it } from "vitest";
import { findArchaic, type RoleModel } from "../../../lib/roles/index.js";

const RATES = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };

function model(
	id: string,
	provider: string,
	cost: Partial<typeof RATES> = {},
): RoleModel {
	return { id, provider, cost: { ...RATES, ...cost } };
}

describe("finding archaic models", () => {
	it("flags a sibling that is both older and no cheaper on any axis", () => {
		const models = [
			model("claude-opus-4-5", "anthropic", { cacheRead: 2 }),
			model("claude-opus-4-8", "anthropic", { cacheRead: 1 }),
		];
		const findings = findArchaic(models);
		expect(findings).toHaveLength(1);
		expect(findings[0].id).toBe("claude-opus-4-5");
		expect(findings[0].supersededBy).toBe("claude-opus-4-8");
	});

	it("does not flag an older sibling that is still cheaper on some axis", () => {
		// A genuine price/capability tradeoff, not obsolescence: the older
		// one still earns its place on at least one axis.
		const models = [
			model("claude-opus-4-5", "anthropic", { cacheRead: 1, output: 5 }),
			model("claude-opus-4-8", "anthropic", { cacheRead: 1, output: 8 }),
		];
		expect(findArchaic(models)).toEqual([]);
	});

	it("compares numeric version components, not lexical string order", () => {
		// Lexically "4-8" < "5", but 5 is the newer major line.
		const models = [
			model("claude-opus-4-8", "anthropic", { cacheRead: 2 }),
			model("claude-opus-5", "anthropic", { cacheRead: 1 }),
		];
		const findings = findArchaic(models);
		expect(findings.map((f) => f.id)).toEqual(["claude-opus-4-8"]);
	});

	it("treats a longer version as newer when the shared prefix matches", () => {
		const models = [
			model("claude-opus-5", "anthropic", { cacheRead: 2 }),
			model("claude-opus-5-5", "anthropic", { cacheRead: 1 }),
		];
		const findings = findArchaic(models);
		expect(findings.map((f) => f.id)).toEqual(["claude-opus-5"]);
	});

	it("does not compare across families", () => {
		const models = [
			model("claude-opus-5", "anthropic", { cacheRead: 5 }),
			model("claude-sonnet-5", "anthropic", { cacheRead: 1 }),
		];
		expect(findArchaic(models)).toEqual([]);
	});

	it("does not compare across provider namespaces", () => {
		// anthropic and anthropic-flex overlap in catalog but are reached
		// differently, so a cheaper entry on one says nothing about the
		// other being obsolete.
		const models = [
			model("claude-opus-4-5", "anthropic", { cacheRead: 5 }),
			model("claude-opus-4-8", "anthropic-flex", { cacheRead: 1 }),
		];
		expect(findArchaic(models)).toEqual([]);
	});

	it("treats a pinned date snapshot as the same version, not a newer one", () => {
		const models = [
			model("claude-opus-4-5", "anthropic", { cacheRead: 1 }),
			model("claude-opus-4-5-20251101", "anthropic", { cacheRead: 1 }),
		];
		expect(findArchaic(models)).toEqual([]);
	});

	it("supersedes by the cheapest strictly-newer sibling, when several exist", () => {
		const models = [
			model("claude-opus-4-5", "anthropic", { cacheRead: 3 }),
			model("claude-opus-4-6", "anthropic", { cacheRead: 2 }),
			model("claude-opus-4-7", "anthropic", { cacheRead: 2.5 }),
		];
		const findings = findArchaic(models);
		expect(findings).toHaveLength(1);
		expect(findings[0].id).toBe("claude-opus-4-5");
		expect(findings[0].supersededBy).toBe("claude-opus-4-6");
	});
});

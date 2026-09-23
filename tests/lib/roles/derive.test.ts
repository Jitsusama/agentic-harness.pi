import { describe, expect, it } from "vitest";
import { deriveRoles, type RoleModel } from "../../../lib/roles/index.js";

function model(id: string, provider: string, cacheRead: number): RoleModel {
	return {
		id,
		provider,
		cost: { input: 1, output: 1, cacheRead, cacheWrite: 1 },
	};
}

describe("deriving premium, primary and light per provider", () => {
	it("gives a single model no role but primary, since there is nothing to rank it against", () => {
		const roles = deriveRoles([model("only-model", "acme", 1)]);
		expect(roles).toEqual([
			{
				provider: "acme",
				premium: undefined,
				primary: "only-model",
				light: undefined,
			},
		]);
	});

	it("splits two models into light and premium, with no middle to call primary", () => {
		const roles = deriveRoles([
			model("cheap", "acme", 1),
			model("dear", "acme", 5),
		]);
		expect(roles).toEqual([
			{ provider: "acme", premium: "dear", primary: undefined, light: "cheap" },
		]);
	});

	it("ranks three models by cache read cost into all three roles", () => {
		const roles = deriveRoles([
			model("dear", "acme", 9),
			model("cheap", "acme", 1),
			model("middle", "acme", 5),
		]);
		expect(roles).toEqual([
			{ provider: "acme", premium: "dear", primary: "middle", light: "cheap" },
		]);
	});

	it("keeps providers separate", () => {
		const roles = deriveRoles([
			model("a-cheap", "acme", 1),
			model("a-dear", "acme", 9),
			model("b-cheap", "beta", 2),
			model("b-dear", "beta", 8),
		]);
		expect(roles).toHaveLength(2);
		expect(roles.find((r) => r.provider === "acme")).toEqual({
			provider: "acme",
			premium: "a-dear",
			primary: undefined,
			light: "a-cheap",
		});
		expect(roles.find((r) => r.provider === "beta")).toEqual({
			provider: "beta",
			premium: "b-dear",
			primary: undefined,
			light: "b-cheap",
		});
	});

	it("is deterministic when cache read costs tie", () => {
		const first = deriveRoles([
			model("z", "acme", 1),
			model("a", "acme", 1),
			model("m", "acme", 1),
		]);
		const second = deriveRoles([
			model("m", "acme", 1),
			model("z", "acme", 1),
			model("a", "acme", 1),
		]);
		expect(first).toEqual(second);
	});
});

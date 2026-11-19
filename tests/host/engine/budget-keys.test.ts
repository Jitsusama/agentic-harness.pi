/**
 * The host sends a budget's key only where the budget listed it, and
 * says when a conversation's budget was laid before budgets listed keys.
 */
import { expect, it } from "vitest";
import {
	budgetKey,
	laidKeys,
	unlistedKeys,
} from "../../../host/engine/budget-keys.ts";

it("takes the keys a budget listed, leaving empty ones out", () => {
	expect(
		laidKeys({
			PI_BUDGET: "team",
			PI_BUDGET_KEYS: "SHOPIFY_PROXY_KEY,PI_PROXY_API_KEY",
			SHOPIFY_PROXY_KEY: "team-key",
			PI_PROXY_API_KEY: "",
		}),
	).toEqual({ SHOPIFY_PROXY_KEY: "team-key" });
});

it("takes none on no budget, or from a budget that listed none", () => {
	expect(
		laidKeys({
			PI_BUDGET_KEYS: "SHOPIFY_PROXY_KEY",
			SHOPIFY_PROXY_KEY: "launch-key",
		}),
	).toEqual({});
	expect(
		laidKeys({
			PI_BUDGET: "team",
			SHOPIFY_PROXY_KEY: "launch-key",
		}),
	).toEqual({});
});

it("takes a budget's gateway key under whichever name it laid it", () => {
	expect(
		budgetKey({
			PI_BUDGET: "team",
			PI_BUDGET_KEYS: "PI_PROXY_API_KEY",
			SHOPIFY_PROXY_KEY: "launch-key",
			PI_PROXY_API_KEY: "team-key",
		}),
	).toBe("team-key");
	expect(
		budgetKey({
			PI_BUDGET: "team",
			PI_BUDGET_KEYS: "PI_PROXY_AUTH_HEADER",
			PI_PROXY_AUTH_HEADER: "Bearer team-key",
		}),
	).toBeUndefined();
});

it("names the keys of a budget laid before budgets listed theirs, and none otherwise", () => {
	expect(
		unlistedKeys({
			PI_BUDGET: "team",
			SHOPIFY_PROXY_KEY: "team-key",
			PI_PROXY_API_KEY: "team-key",
		}),
	).toEqual(["SHOPIFY_PROXY_KEY", "PI_PROXY_API_KEY"]);
	// A budget that listed none lays no key, so a launch's is no budget's.
	expect(
		unlistedKeys({
			PI_BUDGET: "keyless",
			PI_BUDGET_KEYS: "",
			SHOPIFY_PROXY_KEY: "launch-key",
		}),
	).toEqual([]);
	expect(unlistedKeys({ SHOPIFY_PROXY_KEY: "launch-key" })).toEqual([]);
});

/**
 * The host sends a budget's key only where the budget listed it, and
 * says when a conversation on a budget holds a key its budget didn't list.
 */
import { expect, it } from "vitest";
import { laidKeys, unlistedKeys } from "../../../host/engine/budget-keys.ts";

const NAMES = ["SHOPIFY_PROXY_KEY", "PI_PROXY_API_KEY"];

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

it("names a key a budget's conversation holds unlisted, and none off a budget", () => {
	expect(
		unlistedKeys(
			{
				PI_BUDGET: "team",
				PI_BUDGET_KEYS: "SHOPIFY_PROXY_KEY",
				SHOPIFY_PROXY_KEY: "team-key",
				PI_PROXY_API_KEY: "older-team-key",
			},
			NAMES,
		),
	).toEqual(["PI_PROXY_API_KEY"]);
	expect(unlistedKeys({ SHOPIFY_PROXY_KEY: "launch-key" }, NAMES)).toEqual([]);
});

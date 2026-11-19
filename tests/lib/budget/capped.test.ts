/**
 * The bus ask a session makes when the person's own key is capped,
 * and how a cap refusal is told from the failures around it.
 */

import { describe, expect, it } from "vitest";
import {
	askBudgetWhenCapped,
	isCapRefusal,
	onBudgetCapped,
} from "../../../lib/budget/capped.ts";
import { fakePi } from "../../support/fake-pi.ts";

const WEEKLY =
	'403 {"type":"error","error":{"type":"permission_error","message":"Personal token usage is over your weekly cap, so access is temporarily restricted. To keep using the proxy, claim a temporary increase at https://agentplane.shopify.io/personal"}}';
const ALLOWED =
	'403 {"type":"error","error":{"type":"permission_error","message":"Personal token usage is over the allowed cap. Access is temporarily restricted. Please reach out to #token-circuit-breaker.","code":"usage_cap_exceeded"}}';

describe("a cap refusal", () => {
	it("is either of the proxy's refusals of the person's own key", () => {
		expect(isCapRefusal(WEEKLY)).toBe(true);
		expect(isCapRefusal(ALLOWED)).toBe(true);
	});

	it("is no rate limit, other refusal or missing message", () => {
		expect(isCapRefusal("429 rate_limit_error: TPM Limit Hit")).toBe(false);
		expect(isCapRefusal("403 permission_error: model not allowed")).toBe(false);
		expect(
			isCapRefusal("500 personal token usage is over, said a broken relay"),
		).toBe(false);
		expect(isCapRefusal(undefined)).toBe(false);
	});
});

describe("asking for a budget when capped", () => {
	it("gets the budget the keeper lays, with the refusal's words", async () => {
		const pi = fakePi();
		const heard: string[] = [];
		onBudgetCapped(pi.events, async (because) => {
			heard.push(because);
			return "worldtree";
		});

		await expect(askBudgetWhenCapped(pi.events, "over its cap")).resolves.toBe(
			"worldtree",
		);
		expect(heard).toEqual(["over its cap"]);
	});

	it("gets none when nothing keeps a budget", async () => {
		await expect(askBudgetWhenCapped(fakePi().events, "capped")).resolves.toBe(
			null,
		);
	});

	it("gets none when the keeper fails", async () => {
		const pi = fakePi();
		onBudgetCapped(pi.events, () => Promise.reject(new Error("gone")));

		await expect(askBudgetWhenCapped(pi.events, "capped")).resolves.toBe(null);
	});

	it("is answered by the first keeper alone", async () => {
		const pi = fakePi();
		onBudgetCapped(pi.events, async () => "worldtree");
		onBudgetCapped(pi.events, async () => "delta");

		await expect(askBudgetWhenCapped(pi.events, "capped")).resolves.toBe(
			"worldtree",
		);
	});

	it("stops hearing once unsubscribed", async () => {
		const pi = fakePi();
		const off = onBudgetCapped(pi.events, async () => "worldtree");
		off();

		await expect(askBudgetWhenCapped(pi.events, "capped")).resolves.toBe(null);
	});
});

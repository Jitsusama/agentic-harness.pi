import { afterEach, describe, expect, it } from "vitest";
import {
	clearReviewProviders,
	getReviewProvider,
	listReviewProviders,
	registerReviewProvider,
	unregisterReviewProvider,
} from "../../../lib/review";
import { stubProvider } from "./support/stub-provider.js";

afterEach(() => clearReviewProviders());

describe("the review provider registry", () => {
	it("holds nothing until something registers", () => {
		expect(listReviewProviders()).toEqual([]);
	});

	it("registers, retrieves and unregisters a provider", () => {
		const provider = stubProvider({ id: "github", priority: 100 });
		registerReviewProvider(provider);
		expect(getReviewProvider("github")).toBe(provider);
		unregisterReviewProvider("github");
		expect(getReviewProvider("github")).toBeUndefined();
	});

	it("replaces a provider registered under the same id", () => {
		registerReviewProvider(stubProvider({ id: "github", priority: 100 }));
		registerReviewProvider(stubProvider({ id: "github", priority: 10 }));
		expect(listReviewProviders()).toHaveLength(1);
		expect(getReviewProvider("github")?.priority).toBe(10);
	});

	it("lists providers in claim order, most specific first", () => {
		registerReviewProvider(stubProvider({ id: "github", priority: 100 }));
		registerReviewProvider(stubProvider({ id: "git", priority: 900 }));
		registerReviewProvider(stubProvider({ id: "meteorite", priority: 50 }));
		expect(listReviewProviders().map((p) => p.id)).toEqual([
			"meteorite",
			"github",
			"git",
		]);
	});
});

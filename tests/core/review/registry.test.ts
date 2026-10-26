import { afterEach, describe, expect, it } from "vitest";
import {
	clearReviewProviders,
	getReviewProvider,
	listReviewProviders,
	registerReviewProvider,
	unregisterReviewProvider,
} from "../../../lib/core/review/index.ts";
import { stubProvider } from "../../support/stub-provider.ts";

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

	it("reads a provider still naming its changes facet proposals", async () => {
		// Another package's provider may predate the glossary's change.
		const { capabilities, ...rest } = stubProvider({
			id: "older",
			priority: 50,
		});
		const facet = {
			fetch: async () => {
				throw new Error("not fetched here");
			},
			diff: async () => "the diff",
		};
		registerReviewProvider({
			...rest,
			capabilities: (repo) => ({
				...capabilities(repo),
				proposals: { fetchAsRef: false, checks: false, list: false },
			}),
			proposals: facet,
		});

		const found = getReviewProvider("older");
		const said = found?.capabilities({ key: "local:/src/app" });

		expect(found?.changes).toBe(facet);
		expect(said?.changes).toEqual({
			fetchAsRef: false,
			checks: false,
			list: false,
		});
		expect(said).not.toHaveProperty("proposals");
		expect(getReviewProvider("older")).toBe(found);
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

import { afterEach, describe, expect, it } from "vitest";
import type { Change } from "../../../lib/core/review/change.ts";
import {
	clearReviewProviders,
	getReviewProvider,
	listReviewProviders,
	registerReviewProvider,
	unregisterReviewProvider,
} from "../../../lib/core/review/index.ts";
import type { Stack } from "../../../lib/core/review/stack.ts";
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

	it("reads a stack whose nodes still name their change proposal", async () => {
		// Another package's stacks may predate the glossary's change.
		const change = { title: "PR 2" } as unknown as Change;
		const older: Stack = {
			provenance: "authoritative",
			nodes: [
				{ ref: "main" },
				{ ref: "topic", parent: "main", proposal: change },
			],
		};
		registerReviewProvider({
			...stubProvider({ id: "older", priority: 50 }),
			stacking: {
				stack: async () => older,
				restack: async () => older,
			},
		});

		const found = getReviewProvider("older");
		const subject = { repo: { key: "local:/src/app" }, ref: "topic" };
		const stack = await found?.stacking?.stack(subject);
		const restacked = await found?.stacking?.restack?.(subject);

		expect(stack?.nodes).toEqual([
			{ ref: "main" },
			{ ref: "topic", parent: "main", change },
		]);
		expect(restacked?.nodes[1].change).toBe(change);
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearUrlFetchers,
	fetchUrlHints,
	getUrlFetcher,
	listUrlFetchers,
	registerBuiltinUrlFetchers,
	registerUrlFetcher,
	type UrlFetcher,
} from "../../../lib/quest/index";

beforeEach(() => clearUrlFetchers());
afterEach(() => clearUrlFetchers());

describe("url-fetchers registry", () => {
	it("registers a fetcher and looks it up by type", () => {
		const fake: UrlFetcher = {
			type: "fake",
			async fetch() {
				return { title: "Hi" };
			},
		};
		registerUrlFetcher(fake);
		expect(getUrlFetcher("fake")).toBe(fake);
		expect(listUrlFetchers()).toEqual([fake]);
	});

	it("registerBuiltinUrlFetchers seeds github-issue and github-pr", () => {
		registerBuiltinUrlFetchers();
		expect(
			listUrlFetchers()
				.map((f) => f.type)
				.sort(),
		).toEqual(["github-issue", "github-pr"]);
	});

	it("fetchUrlHints dispatches by type", async () => {
		registerUrlFetcher({
			type: "fake",
			async fetch(ref) {
				return { title: `Got ${ref.value}` };
			},
		});
		const hints = await fetchUrlHints({ type: "fake", value: "v" });
		expect(hints?.title).toBe("Got v");
	});

	it("returns undefined when no fetcher matches", async () => {
		expect(
			await fetchUrlHints({ type: "unregistered", value: "v" }),
		).toBeUndefined();
	});

	it("swallows fetcher errors as undefined", async () => {
		registerUrlFetcher({
			type: "fake",
			async fetch() {
				throw new Error("boom");
			},
		});
		expect(await fetchUrlHints({ type: "fake", value: "v" })).toBeUndefined();
	});
});

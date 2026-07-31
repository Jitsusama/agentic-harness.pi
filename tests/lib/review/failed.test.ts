/**
 * What a failure against a hosted change says.
 *
 * Driven from a real one: closing `shop/world#2001291` answered `gh: Not Found
 * (HTTP 404)`, which named neither the provider that had been asked nor the
 * setting that decides which provider gets asked. The reference had been
 * claimed by GitHub because `owner/repo#n` is GitHub's spelling too, and
 * nothing had pinned that repo to the system actually serving it.
 */

import { describe, expect, it } from "vitest";
import {
	explainFailure,
	type FailureContext,
	readsAsMissing,
} from "../../../lib/review/failed.js";

const claimed: FailureContext = {
	provider: { id: "github" },
	repo: { key: "github:shop/world" },
	via: "claim",
};

describe("explaining a failure against a hosted change", () => {
	it("names the provider asked and why it was asked", async () => {
		const said = explainFailure("gh: Not Found (HTTP 404)", claimed);

		expect(said).toContain("gh: Not Found (HTTP 404)");
		expect(said).toContain("github provider was asked");
		expect(said).toContain("recognized the shape");
	});

	it("names the pin, and the url that sidesteps it", async () => {
		const said = explainFailure("gh: Not Found (HTTP 404)", claimed);

		expect(said).toContain("review.repos");
		expect(said).toMatch(/url/i);
	});

	it("keeps the original message first, and whole", async () => {
		// The backend's own words are the evidence. A decoration that
		// paraphrases or replaces them costs more than it adds.
		const said = explainFailure("gh: Not Found (HTTP 404)", claimed);

		expect(said.startsWith("gh: Not Found (HTTP 404)")).toBe(true);
	});

	it("says nothing extra when config already chose the provider", async () => {
		// A pin cannot be the advice when a pin is what got us here, and a
		// not-found under one means what it says.
		const said = explainFailure("gh: Not Found (HTTP 404)", {
			...claimed,
			via: "config-repo",
		});

		expect(said).toBe("gh: Not Found (HTTP 404)");
	});

	it("says nothing extra when the reference shape was mapped by config", async () => {
		const said = explainFailure("gh: Not Found (HTTP 404)", {
			...claimed,
			via: "config-reference",
		});

		expect(said).toBe("gh: Not Found (HTTP 404)");
	});

	it("leaves a failure that is not a not-found alone", async () => {
		// A 422 is the backend understanding the request and rejecting its
		// contents, which is a real answer about a real change. Decorating it
		// would be wrong, and would train a reader to skip the decoration
		// where it counts.
		const said = explainFailure(
			"Review cannot be requested from pull request author. (HTTP 422)",
			claimed,
		);

		expect(said).toBe(
			"Review cannot be requested from pull request author. (HTTP 422)",
		);
	});
});

describe("recognizing a failure that reads as missing", () => {
	it("catches the spellings backends actually use", async () => {
		expect(readsAsMissing("gh: Not Found (HTTP 404)")).toBe(true);
		expect(readsAsMissing("HTTP 404")).toBe(true);
		expect(readsAsMissing("Could not resolve to a PullRequest")).toBe(true);
		expect(readsAsMissing("no such pull request")).toBe(true);
	});

	it("does not catch a request the backend understood", async () => {
		expect(readsAsMissing("validation failed (HTTP 422)")).toBe(false);
		expect(readsAsMissing("path is not changed in this pull request")).toBe(
			false,
		);
		expect(readsAsMissing("permission denied (HTTP 403)")).toBe(false);
	});
});

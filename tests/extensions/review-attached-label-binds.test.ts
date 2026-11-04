/**
 * Naming an attached change by its label binds the change attached.
 *
 * A label is what every answer prints, so it is what a caller names
 * back. Naming it used to parse it afresh, as if never seen, and the
 * same `owner/repo#number` can be claimed by two providers: a Delta
 * change attached from a URL came back, named from another checkout,
 * as a GitHub pull request, and a remark meant for Delta went to `gh`,
 * which has no such pull request and answered 404.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	type ChangeRef,
	type ConversationFacet,
	clearReviewProviders,
	clearTargetBindings,
	registerReviewProvider,
} from "../../lib/core/review/index.ts";
import { stubProvider } from "../support/stub-provider.ts";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.ts";

const URL = "https://delta.example/shop/world/pull/2373695";
const LABEL = "shop/world#2373695";

/** A conversation that records which provider was asked to comment. */
function conversation(id: string, said: string[]): ConversationFacet {
	const unused = async (): Promise<never> => {
		throw new Error(`this test never asks ${id} for that`);
	};
	return {
		reviews: unused,
		threads: async () => [],
		messages: async () => [],
		postReview: unused,
		reply: unused,
		resolve: unused,
		comment: async (_ref: ChangeRef, body: string) => {
			said.push(`${id}: ${body}`);
			return {};
		},
	};
}

/**
 * Two providers that both host `shop/world`, as Delta and the GitHub
 * mirror do: the first claims its URL, and its short form only from a
 * checkout of its own; the second claims any short form by shape.
 */
function twoHosts(said: string[]): void {
	registerReviewProvider(
		stubProvider({
			id: "delta",
			priority: 40,
			claimReference: (input, repo) => {
				const id =
					/\/pull\/(\d+)$/.exec(input)?.[1] ??
					(repo?.key === "delta:shop/world"
						? /^shop\/world#(\d+)$/.exec(input)?.[1]
						: undefined);
				return id === undefined
					? null
					: {
							provider: "delta",
							repo: { key: "delta:shop/world" },
							id,
							label: `shop/world#${id}`,
						};
			},
			facets: { conversation: conversation("delta", said) },
		}),
	);
	registerReviewProvider(
		stubProvider({
			id: "github",
			priority: 100,
			claimReference: (input) => {
				const id = /^shop\/world#(\d+)$/.exec(input)?.[1];
				return id === undefined
					? null
					: {
							provider: "github",
							repo: { key: "github:shop/world" },
							id,
							label: `shop/world#${id}`,
						};
			},
			facets: { conversation: conversation("github", said) },
		}),
	);
}

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("a change named by the label it was attached under", () => {
	it("takes the remark to the provider it was attached through", async () => {
		const said: string[] = [];
		const stub = activate();
		// After activating, so the stand-in replaces the GitHub provider the
		// extension registers rather than being replaced by it.
		twoHosts(said);
		const review = toolNamed(stub, "review");
		const say = toolNamed(stub, "review_say");

		await review.execute(
			"attach",
			{ action: "attach", change: URL },
			undefined,
			undefined,
			HEADLESS,
		);
		await say.execute(
			"comment",
			{ action: "comment", change: LABEL, body: "/merge" },
			undefined,
			undefined,
			HEADLESS,
		);

		expect(said).toEqual(["delta: /merge"]);
	});
});

/**
 * A declared capability has to be backed by a method that exists.
 *
 * This gate came from the Meteorite provider, which was caught claiming
 * four things it had never implemented: `proposals: { fetchAsRef: true,
 * checks: true, list: true }` and later `authoring.proposeStack`. Nothing
 * crashed, which is why it survived for weeks. The engine reaches those
 * methods through `?.`, so `review_see checks` answered "the provider
 * reports no checks for this target" and read like a backend without CI
 * rather than a provider with a hole in it, while a consumer that asked
 * the capabilities first was told yes.
 *
 * It lives here as well as there because the fault is a property of the
 * contract, not of one backend, and because a provider in another package
 * cannot be reached from this suite. Every package shipping a provider
 * needs its own copy of this question.
 *
 * The comparison is mechanical on purpose. A test that reads a
 * declaration back and asserts it equals itself is exactly the test this
 * class of fault passes.
 */

import { describe, expect, it } from "vitest";
import {
	createGitHubProvider,
	createGitProvider,
	type ReviewProvider,
} from "../../../lib/review/index.js";

/**
 * Which method has to exist for each capability that promises one.
 *
 * Only capabilities promising a callable belong here. One describing
 * behaviour, like `staleness: "pinned"` or `maxBatchComments`, is a fact
 * about the backend rather than a promise about this object.
 *
 * This table was checked against the contract rather than assembled from
 * memory: every boolean capability whose name matches a facet method is
 * in it. Three optional methods have no capability of any kind, which is
 * the opposite gap and a milder one. `commentOn`, `unreact` and `fileAt`
 * can only be discovered by looking for the method, so a consumer cannot
 * ask ahead of time and has to degrade on absence instead. Nothing lies;
 * it just cannot be asked.
 *
 * `reactions` and `reviewersAt` say more than a boolean can, and were once
 * left out for that reason. That was wrong, and it left the worst hole in
 * the gate uncovered, because `reviewersAt` is the one declaration a
 * caller is told about in the past tense: `review_offer` reports "asked
 * alice, bob" from an optional call that quietly does nothing when the
 * method is missing. So a row carries a predicate over the declared value
 * rather than assuming `true`, and both are held to the same standard as
 * the rest. What each promises is narrower than its type: a non-empty
 * reaction set promises `react`, and only an "any-time" policy promises
 * `requestReviewers`, since "creation" is served through `propose`.
 *
 * A row also says whether the contract requires the method, because the
 * two directions are not symmetric. Where a method is mandatory its
 * presence is guaranteed by the type and proves nothing about what the
 * provider means, so demanding a declaration to match it would push a
 * provider that legitimately cannot propose into saying it can.
 */
const BACKED_BY: ReadonlyArray<{
	facet: "proposals" | "conversation" | "authoring";
	capability: string;
	method: string;
	/** When the declared value amounts to a promise. Defaults to `=== true`. */
	promises?: (declared: unknown) => boolean;
	/** The facet requires this method, so its presence says nothing. */
	mandatory?: true;
}> = [
	{ facet: "proposals", capability: "checks", method: "checks" },
	{ facet: "proposals", capability: "list", method: "list" },
	{ facet: "proposals", capability: "fetchAsRef", method: "fetchAsRef" },
	{ facet: "conversation", capability: "unresolve", method: "unresolve" },
	{
		facet: "authoring",
		capability: "propose",
		method: "propose",
		mandatory: true,
	},
	{ facet: "authoring", capability: "proposeStack", method: "proposeStack" },
	{ facet: "authoring", capability: "setDraft", method: "setDraft" },
	{ facet: "authoring", capability: "close", method: "close", mandatory: true },
	{ facet: "authoring", capability: "reopen", method: "reopen" },
	{ facet: "authoring", capability: "merge", method: "merge", mandatory: true },
	{
		facet: "conversation",
		capability: "reactions",
		method: "react",
		// Naming the reactions it accepts is the promise. An empty set is
		// the contract's own way of saying it does none.
		promises: (declared) => Array.isArray(declared) && declared.length > 0,
	},
	{
		facet: "authoring",
		capability: "reviewersAt",
		method: "requestReviewers",
		// Meteorite is the live example of the other value: it declares
		// "creation", omits the method deliberately, and the offer gate
		// refuses before anything is called.
		promises: (declared) => declared === "any-time",
	},
];

/** An exec that must never run, since nothing here executes a command. */
const unused = async () => {
	throw new Error("building a provider must not run a command");
};

/** Every provider this package ships. */
const PROVIDERS: ReadonlyArray<[string, ReviewProvider]> = [
	["github", createGitHubProvider({ exec: unused })],
	["git", createGitProvider({ exec: unused })],
];

/** The repo each provider is asked about, in its own key space. */
const REPO_FOR: Record<string, { key: string }> = {
	github: { key: "github:Shopify/world" },
	git: { key: "git:/tmp/repo" },
};

for (const [id, provider] of PROVIDERS) {
	describe(`${id}: every capability that promises a method has one`, () => {
		for (const { facet, capability, method, promises } of BACKED_BY) {
			it(`backs ${facet}.${capability} with a callable`, async () => {
				const declared = await provider.capabilities(REPO_FOR[id]);
				const claims = declared[facet] as Record<string, unknown> | undefined;
				const amounts = promises ?? ((value: unknown) => value === true);
				if (!claims || !amounts(claims[capability])) return;

				const built = provider[facet] as Record<string, unknown> | undefined;
				expect(
					typeof built?.[method],
					`${id} declares ${facet}.${capability} as ${JSON.stringify(claims[capability])}, which promises ${method}, so it has to exist. Either implement it or stop claiming it: the engine calls it through an optional chain, so the hole reads as a backend without the feature rather than as a bug.`,
				).toBe("function");
			});
		}
	});

	describe(`${id}: a method that exists is declared`, () => {
		// The quieter lie, and still a lie: a facet that can do something
		// while its capabilities say it cannot means a consumer politely
		// declines to use a working feature.
		for (const {
			facet,
			capability,
			method,
			promises,
			mandatory,
		} of BACKED_BY) {
			if (mandatory) continue;
			it(`declares ${capability} when ${method} is there`, async () => {
				const built = provider[facet] as Record<string, unknown> | undefined;
				if (typeof built?.[method] !== "function") return;

				const declared = await provider.capabilities(REPO_FOR[id]);
				const claims = declared[facet] as Record<string, unknown> | undefined;
				const amounts = promises ?? ((value: unknown) => value === true);
				expect(
					claims !== undefined && amounts(claims[capability]),
					`${id} implements ${facet}.${method} but declares ${capability} as ${JSON.stringify(claims?.[capability])}, which does not promise it, so a consumer that asks first will never call it.`,
				).toBe(true);
			});
		}
	});
}

describe("the gate itself", () => {
	it("finds capabilities to check, rather than passing on an empty table", async () => {
		// A mapping that matched nothing would pass every case above by
		// returning early, which is how a gate stops meaning anything.
		const github = await createGitHubProvider({
			exec: unused,
		}).capabilities(REPO_FOR.github);
		const live = BACKED_BY.filter(({ facet, capability }) => {
			const claims = github[facet] as Record<string, unknown> | undefined;
			return claims?.[capability] === true;
		});

		expect(live.length).toBeGreaterThan(5);
	});
});

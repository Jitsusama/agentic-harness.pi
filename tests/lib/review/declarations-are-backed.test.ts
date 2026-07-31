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
 * The table this checks against used to live in this file, and a second
 * hand-copied one lived in the package shipping the Meteorite provider,
 * because a test here cannot import a provider that arrives over the event
 * bus from somewhere else. Two copies of a rule is one rule and one guess
 * about it, and the copy was free to drift from the contract it was
 * checking. Both now read `BACKED_BY` out of the library, and the same
 * comparison runs in production through `unbackedDeclarations`, which
 * `review capabilities` calls with the repo actually in play.
 *
 * So what is left here is narrower than what was here before: that the
 * providers this package ships pass, that the shared table still describes
 * the contract, and that the comparison itself catches what it claims to.
 * The comparison is mechanical on purpose. A test that reads a declaration
 * back and asserts it equals itself is exactly the test this class of
 * fault passes.
 */

import { describe, expect, it } from "vitest";
import {
	BACKED_BY,
	createGitHubProvider,
	createGitProvider,
	type RepoLocator,
	type ReviewProvider,
	registerReviewProvider,
	unbackedDeclarations,
	unregisterReviewProvider,
} from "../../../lib/review/index.js";

/**
 * An exec that refuses, since building a provider must run no command.
 *
 * Rolled here rather than reached for from support/fake-exec.ts on purpose:
 * a fake that answers cleanly would let a construction-time command through
 * and nobody would see it. That is what the name has to carry, and calling
 * it `unused` said the one thing about it that is false, since it is passed
 * to every provider in the file.
 */
const refusesToRun = async () => {
	throw new Error("building a provider must not run a command");
};

/** Every provider this package ships. */
const PROVIDERS: ReadonlyArray<[string, ReviewProvider]> = [
	["github", createGitHubProvider({ exec: refusesToRun })],
	["git", createGitProvider({ exec: refusesToRun })],
];

/**
 * The repo each provider is asked about, in its own key space.
 *
 * The git provider's space is `local:`, not `git:`, which is what its own
 * `claimRepo` mints and what every other test of it uses. The wrong prefix
 * sat here contradicting the sentence above it, and was invisible because
 * neither provider's `capabilities` reads its argument at all. It would
 * stop being invisible for the first provider whose answer varies by repo,
 * which is the kind this gate is being copied for: handed a key it does not
 * recognize, it would return a default and every row would take the early
 * return, reporting greens having compared nothing.
 *
 * `localPath` rides along because it is the only field a local provider
 * ever reads off a locator.
 */
const REPO_FOR: Record<string, RepoLocator> = {
	github: { key: "github:Shopify/world" },
	git: { key: "local:/tmp/repo", localPath: "/tmp/repo" },
};

for (const [id, provider] of PROVIDERS) {
	describe(`${id}: every capability that promises a method has one`, () => {
		for (const { facet, capability, method, promises } of BACKED_BY) {
			it(`backs ${facet}.${capability} with a callable`, () => {
				// Not awaited: `capabilities` returns a `Capabilities`, not a
				// promise, and the engine calls it plainly while building a bound
				// target. Awaiting it here described asking a provider what it can
				// do as I/O, in the one file whose subject is what the contract
				// actually requires.
				const declared = provider.capabilities(REPO_FOR[id]);
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
			it(`declares ${capability} when ${method} is there`, () => {
				const built = provider[facet] as Record<string, unknown> | undefined;
				if (typeof built?.[method] !== "function") return;

				const declared = provider.capabilities(REPO_FOR[id]);
				const claims = declared[facet] as Record<string, unknown> | undefined;
				const amounts = promises ?? ((value: unknown) => value === true);
				expect(
					claims !== undefined && amounts(claims[capability]),
					`${id} implements ${facet}.${method} but declares ${capability} as ${JSON.stringify(claims?.[capability])}, which does not promise it, so a consumer that asks first will never call it.`,
				).toBe(true);
			});
		}
	});

	it(`${id} passes the check that runs in production`, () => {
		// The rows above walk the table by hand and give a per-row failure
		// message. This asks the one function a running session uses, which is
		// what would actually report a fault to a person.
		expect(unbackedDeclarations(provider, REPO_FOR[id])).toEqual([]);
	});
}

describe("the shared table", () => {
	it("compares exactly these declarations, named rather than counted", () => {
		// A mapping that matched nothing would pass every case above by
		// returning early, which is how a gate stops meaning anything.
		//
		// This was a floor, and a floor was the wrong instrument. It read
		// `toBeGreaterThan(5)` against eleven live rows, so four could be
		// typoed dead in silence, and the number itself was underivable from
		// anything: two separate readers worked out its slack and both got it
		// wrong, in different directions. Naming the set says strictly more,
		// needs no arithmetic from anybody, and turns losing a row from a
		// silent shrinkage into a diff with a name on it.
		const github = createGitHubProvider({
			exec: refusesToRun,
		}).capabilities(REPO_FOR.github);
		const live = BACKED_BY.filter(({ facet, capability, promises }) => {
			const claims = github[facet] as Record<string, unknown> | undefined;
			const amounts = promises ?? ((value: unknown) => value === true);
			return claims !== undefined && amounts(claims[capability]);
		}).map(({ facet, capability }) => `${facet}.${capability}`);

		expect(live.sort()).toEqual([
			"authoring.close",
			"authoring.merge",
			"authoring.propose",
			"authoring.reopen",
			"authoring.rerunChecks",
			"authoring.reviewersAt",
			"authoring.setDraft",
			"conversation.fileLevelComments",
			"conversation.reactions",
			"conversation.unresolve",
			"proposals.checks",
			"proposals.fetchAsRef",
			"proposals.list",
		]);
	});
});

/**
 * A provider built to be wrong, so the comparison is exercised against a
 * fault rather than only against providers that pass.
 *
 * Every case above returns green, which is what a gate whose failure path
 * has never run looks like from the outside. The council raised exactly
 * this: twenty of forty-one cases were permanently green, and nothing had
 * ever proved the check could fail.
 */
function providerThatLies(over: {
	declare: Record<string, unknown>;
	implement: Record<string, unknown>;
}): ReviewProvider {
	return {
		id: "liar",
		priority: 99,
		claimRepo: () => undefined,
		claimChange: () => undefined,
		capabilities: () => ({ conversation: over.declare }) as never,
		conversation: over.implement as never,
	} as unknown as ReviewProvider;
}

describe("the comparison itself", () => {
	const reactions = ["rocket"];

	it("catches a declaration with no method behind it", () => {
		const lying = providerThatLies({
			declare: { reactions, unresolve: true },
			implement: {},
		});

		const found = unbackedDeclarations(lying, { key: "any:repo" });

		expect(found.map((one) => one.capability).sort()).toEqual([
			"reactions",
			"unresolve",
		]);
		expect(found.every((one) => one.fault === "declared-without-method")).toBe(
			true,
		);
	});

	it("catches a method nothing will ever call", () => {
		// The direction that hid Meteorite's `requestReviewers` for a release:
		// implemented, working, and undeclared, so every consumer politely
		// declined to use it.
		const lying = providerThatLies({
			declare: { reactions: [] },
			implement: { react: () => {} },
		});

		const found = unbackedDeclarations(lying, { key: "any:repo" });

		expect(found).toHaveLength(1);
		expect(found[0].fault).toBe("method-without-declaration");
	});

	it("says nothing about a facet the provider does not have at all", () => {
		// Declaring nothing and implementing nothing is a coherent position,
		// not a disagreement. A provider that only reads is not lying.
		const quiet = {
			id: "quiet",
			priority: 99,
			claimRepo: () => undefined,
			claimChange: () => undefined,
			capabilities: () => ({}),
		} as unknown as ReviewProvider;

		expect(unbackedDeclarations(quiet, { key: "any:repo" })).toEqual([]);
	});

	it("does not read an unmentioned capability as a claim", () => {
		// Undefined is not a promise. A capability a provider never spoke
		// about is one it has not claimed, and reporting it would make every
		// small provider look like a liar.
		const lying = providerThatLies({ declare: {}, implement: {} });

		expect(unbackedDeclarations(lying, { key: "any:repo" })).toEqual([]);
	});
});

describe("registering a provider", () => {
	it("hands back what the provider was found saying wrongly", () => {
		// The seam every provider crosses however it got here, which is the
		// only place this can be asked of the ones that arrive over the bus.
		const lying = providerThatLies({
			declare: { reactions: ["rocket"] },
			implement: {},
		});

		const complaint = registerReviewProvider(lying, { key: "any:repo" });

		expect(complaint?.provider).toBe("liar");
		expect(complaint?.repo).toBe("any:repo");
		expect(complaint?.unbacked).toHaveLength(1);
		unregisterReviewProvider("liar");
	});

	it("registers it anyway, since one bad claim is not a bad provider", () => {
		// Refusing would take a working backend off the surface over a
		// capability nobody in this session may reach for. Said out loud
		// instead, which is the bargain the rest of the substrate makes.
		const lying = providerThatLies({
			declare: { reactions: ["rocket"] },
			implement: {},
		});

		registerReviewProvider(lying, { key: "any:repo" });

		expect(unregisterReviewProvider("liar")).toBeUndefined();
	});

	it("says nothing when no repo is given to check against", () => {
		// A provider may answer differently for different repos, so checking
		// against a locator nobody supplied would mean inventing one.
		const lying = providerThatLies({
			declare: { reactions: ["rocket"] },
			implement: {},
		});

		expect(registerReviewProvider(lying)).toBeUndefined();
		unregisterReviewProvider("liar");
	});
});

/**
 * Whether a provider's declarations are backed by methods that exist.
 *
 * The fault this answers came from the Meteorite provider, which claimed four
 * things it had never implemented: `proposals: { fetchAsRef: true, checks:
 * true, list: true }` and later `authoring.proposeStack`. Nothing crashed,
 * which is why it survived for weeks. The engine reaches those methods through
 * `?.`, so `review_see checks` answered "the provider reports no checks for
 * this target" and read like a backend without CI rather than a provider with
 * a hole in it, while a consumer that asked the capabilities first was told
 * yes.
 *
 * It began as a test, and as a test it could only ever reach the providers
 * this package ships. Every provider that matters arrives over the event bus
 * from another package: a build-time check cannot import one, so the private
 * copy of this question was a hand-copied table, free to fall behind the
 * contract it was checking against without anything noticing. Two copies of a
 * rule is one rule and one guess about it.
 *
 * So the question lives here, in the library both sides already depend on, and
 * `registerReviewProvider` asks it of every provider that passes through.
 * Registration is the one seam every provider crosses however it got here,
 * which makes it the only place this can be asked of all of them.
 */

import type { Capabilities } from "./capabilities.js";
import type { RepoLocator } from "./change.js";
import type { ReviewProvider } from "./provider.js";

/** Which facets carry capabilities that promise a method. */
type FacetName = "proposals" | "conversation" | "authoring";

/**
 * Which method has to exist for each capability that promises one.
 *
 * Only capabilities promising a callable belong here. One describing
 * behaviour, like `staleness: "pinned"` or `maxBatchComments`, is a fact about
 * the backend rather than a promise about this object.
 *
 * This table was checked against the contract rather than assembled from
 * memory: every capability whose name matches a facet method is in it. Three
 * optional methods have no capability of any kind, which is the opposite gap
 * and a milder one: `unreact` and `fileAt` can only be discovered by looking
 * for the method, so a consumer cannot ask ahead of time and has to degrade on
 * absence instead. Nothing lies; it just cannot be asked. `commentOn` used to
 * be the third, and is now spoken for by `fileLevelComments`.
 *
 * A row carries a predicate over the declared value rather than assuming
 * `true`, because several capabilities say more than a boolean can and leaving
 * them out left the worst hole here uncovered. `reviewersAt` is the one
 * declaration a caller is told about in the past tense: `review_offer` reports
 * "asked alice, bob" from an optional call that quietly does nothing when the
 * method is missing. What each promises is narrower than its type.
 *
 * A row also says whether the contract requires the method, because the two
 * directions are not symmetric. Where a method is mandatory its presence is
 * guaranteed by the type and proves nothing about what the provider means, so
 * demanding a declaration to match it would push a provider that legitimately
 * cannot propose into saying it can.
 */
export const BACKED_BY: ReadonlyArray<{
	facet: FacetName;
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
	{ facet: "authoring", capability: "rerunChecks", method: "rerun" },
	{ facet: "conversation", capability: "unresolve", method: "unresolve" },
	{
		facet: "conversation",
		capability: "fileLevelComments",
		method: "commentOn",
		// "standalone" is the value that promises a method: it says a remark
		// about a whole file has to be posted outside a batch review, and
		// `commentOn` is the only way to post one. "batch" is served by
		// `postReview`, which every conversation facet has.
		promises: (declared) => declared === "standalone",
	},
	{
		facet: "conversation",
		capability: "reactions",
		method: "react",
		// Naming the reactions it accepts is the promise. An empty set is the
		// contract's own way of saying it does none.
		promises: (declared) => Array.isArray(declared) && declared.length > 0,
	},
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
		facet: "authoring",
		capability: "reviewersAt",
		method: "requestReviewers",
		// Meteorite is the live example of the other value: it declares
		// "creation", omits the method deliberately, and the offer gate
		// refuses before anything is called.
		promises: (declared) => declared === "any-time",
	},
];

/** One way a provider's declarations and its methods disagree. */
export interface Unbacked {
	facet: FacetName;
	capability: string;
	method: string;
	/** Which direction the disagreement runs. */
	fault: "declared-without-method" | "method-without-declaration";
	/** Said in full, for a warning a person has to act on. */
	reason: string;
}

function facetOf(
	provider: ReviewProvider,
	facet: FacetName,
): Record<string, unknown> | undefined {
	// Read as an open record on purpose: the whole point is to ask whether a
	// named method is there, and the facet types say which methods may exist
	// rather than letting one be looked up by name.
	const found: unknown = provider[facet];
	return typeof found === "object" && found !== null
		? (found as Record<string, unknown>)
		: undefined;
}

function declaredIn(
	capabilities: Capabilities,
	facet: FacetName,
): Record<string, unknown> | undefined {
	const found = (capabilities as Record<string, unknown>)[facet];
	return typeof found === "object" && found !== null
		? (found as Record<string, unknown>)
		: undefined;
}

/**
 * Compare what a provider says it can do against what it can do.
 *
 * Both directions are reported, because each is its own kind of wrong. A
 * declaration with no method behind it is a lie a consumer acts on; a method
 * with no declaration is work already done that no consumer will ever ask for,
 * which is how Meteorite's `requestReviewers` sat unreachable while the
 * provider said reviewers could only be named at creation.
 *
 * Takes the locator because a provider is entitled to answer differently for
 * different repos, and a provider handed a key from the wrong space would
 * return a default and let every row pass having compared nothing.
 */
export function unbackedDeclarations(
	provider: ReviewProvider,
	repo: RepoLocator,
): Unbacked[] {
	const capabilities = provider.capabilities(repo);
	const found: Unbacked[] = [];

	for (const row of BACKED_BY) {
		const facet = facetOf(provider, row.facet);
		const declared = declaredIn(capabilities, row.facet);

		// A provider without the facet at all has nothing to answer for. It
		// declares nothing about it and implements nothing in it, which is a
		// coherent position rather than a disagreement.
		if (!facet && !declared) continue;

		const value = declared?.[row.capability];
		const promised = row.promises
			? row.promises(value)
			: // Undefined is not a promise. A capability a provider never
				// mentioned is one it has not claimed.
				value === true;
		const implemented = typeof facet?.[row.method] === "function";

		if (promised && !implemented) {
			found.push({
				facet: row.facet,
				capability: row.capability,
				method: row.method,
				fault: "declared-without-method",
				reason: `declares ${row.facet}.${row.capability} and has no ${row.method} to back it, so a consumer that asks first is told yes and a consumer that calls gets silence`,
			});
			continue;
		}

		// Only worth asking where the contract leaves the method optional.
		// Where it is mandatory, presence is guaranteed by the type and says
		// nothing about what the provider meant.
		if (!row.mandatory && implemented && !promised && declared) {
			found.push({
				facet: row.facet,
				capability: row.capability,
				method: row.method,
				fault: "method-without-declaration",
				reason: `implements ${row.facet}.${row.method} and does not declare ${row.capability}, so nothing will ever call it`,
			});
		}
	}

	return found;
}

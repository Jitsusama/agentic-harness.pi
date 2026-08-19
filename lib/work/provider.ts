/**
 * Choosing which provider cuts a tree.
 *
 * This replaces two brokers that sorted their providers in
 * opposite directions. One took the smallest priority number,
 * documented as "built-ins live at 100; downstream
 * specialisations use smaller numbers to take over". The other
 * took the largest, documented as "higher-priority providers are
 * consulted first". Both downstream World providers were correct
 * under their own broker while holding the same constant name at
 * 50 and at 100.
 *
 * Unifying them on either direction would silently invert one, and
 * silently is the operative word: losing does not raise anything,
 * because the general provider still produces a tree. It would
 * just be a plain git worktree where a `dev tree` was wanted,
 * which works well enough to go unnoticed.
 *
 * So the number is not a priority. A provider says how *specific*
 * it is, and more specific wins. "Priority" genuinely reads both
 * ways in English, since priority 1 can mean first or last;
 * "specificity" does not, because a provider for one repo is
 * plainly more specific than one for any repo.
 */

import type { RepoLocator } from "@jitsusama/agentic-harness.core/review";

/** What choosing needs to know about a provider. */
export interface TreeProviderInfo {
	/** Stable identifier, used when reporting the choice. */
	id: string;
	/**
	 * How narrow this provider's remit is. Higher wins. A
	 * provider serving any repo declares 0; one serving a
	 * particular repo declares more.
	 */
	specificity: number;
	/**
	 * Whether this provider serves the given repo. Cheap and
	 * synchronous: it is asked about every provider on every
	 * choice.
	 */
	appliesTo(repo: RepoLocator): boolean;
}

/**
 * Which provider serves a repo.
 *
 * Three outcomes, because the caller has to say something
 * different about each: use it, tell somebody nothing is
 * configured, or tell somebody two things are configured to do the
 * same job.
 */
export type TreeProviderChoice<P> =
	/** Exactly one provider is the most specific that applies. */
	| { kind: "chosen"; provider: P }
	/**
	 * Several apply and are equally specific, so which one serves
	 * is arbitrary. Reported rather than resolved: picking by
	 * registration order hides a configuration mistake behind a
	 * tree that looks fine.
	 */
	| { kind: "ambiguous"; providers: readonly P[] }
	/** Nothing applies. */
	| { kind: "none" };

/**
 * Choose the provider that serves a repo.
 *
 * Ties are reported with the contenders named and in a stable
 * order, so the same misconfiguration reads the same way whichever
 * order the providers happened to register in. A tie below the
 * winner is not a tie at all and is ignored.
 */
export function chooseTreeProvider<P extends TreeProviderInfo>(
	providers: readonly P[],
	repo: RepoLocator,
): TreeProviderChoice<P> {
	const applicable = providers.filter((candidate) => candidate.appliesTo(repo));
	if (applicable.length === 0) return { kind: "none" };

	const narrowest = Math.max(...applicable.map((c) => c.specificity));
	const contenders = applicable
		.filter((candidate) => candidate.specificity === narrowest)
		.sort((a, b) => a.id.localeCompare(b.id));

	const [only] = contenders;
	if (only && contenders.length === 1)
		return { kind: "chosen", provider: only };
	return { kind: "ambiguous", providers: contenders };
}

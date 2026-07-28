/**
 * What the user gets to decide about provider selection.
 *
 * Two knobs, both of which exist because guessing is worse
 * than asking. A repo mapping pins a repo to a provider with
 * ordered fallbacks, which is what a migration needs: while
 * one repo lives on two backends at once, the person doing
 * the work is the only one who knows which of them is the
 * real one today. A reference mapping teaches the substrate
 * a URL or short form no provider recognizes, so an internal
 * link shape can be adopted without shipping code.
 */

/** Pins a repo to providers, first registered one winning. */
export interface RepoMapping {
	/**
	 * Matched as a substring against the checkout path and
	 * each of its remote URLs. Substring rather than a
	 * pattern because the thing people have to hand is a repo
	 * name, and `Shopify/world` should just work.
	 */
	match: string;
	/**
	 * Provider ids in preference order. Ids that are not
	 * registered are skipped, which is what makes this safe
	 * to write before the provider ships.
	 */
	providers: string[];
}

/** Teaches the substrate a reference shape. */
export interface ReferenceMapping {
	/**
	 * Regular expression matched against the whole reference.
	 * Named groups `repo` and `id` are read when present.
	 */
	pattern: string;
	/** Provider to hand the match to. */
	provider: string;
	/** Repo key to use when the pattern names no `repo`. */
	repo?: string;
}

/** The `review` section of the package config. */
export interface ReviewConfig {
	repos?: RepoMapping[];
	references?: ReferenceMapping[];
}

/**
 * Types for the refs library.
 *
 * A `Ref` is a structured reference to an external system
 * entity (a GitHub issue, a Slack thread, a Graphite PR).
 * A `RefType` knows how to recognise its own surface forms
 * in text and how to build a canonical URL from a stored
 * value.
 *
 * The refs library is pluggable: consumers register their
 * own types alongside the built-ins. The quest extension
 * uses it to extract inline references from prose and to
 * resolve aliases in frontmatter; downstream packages can
 * register custom types (e.g. company-specific URL
 * schemes) without forking the library.
 */

/** A structured reference to an external entity. */
export interface Ref {
	/**
	 * The ref type identifier registered via
	 * `registerRefType`, e.g. `"github-issue"`,
	 * `"slack-thread"`.
	 */
	type: string;
	/**
	 * The canonical value for this ref. Format is
	 * type-specific (e.g. `"shop/world#47281"` for
	 * `github-issue`, a Slack archive URL fragment for
	 * `slack-thread`). The type's `matchAll` produces this
	 * value; its `url` reverses it.
	 */
	value: string;
}

/** Definition of a ref type. */
export interface RefType {
	/**
	 * Unique identifier for this type. Used as the
	 * discriminator in `Ref.type` and the key in the
	 * registry. Convention is kebab-case with the system
	 * prefix, e.g. `"github-issue"`, `"slack-thread"`.
	 */
	type: string;
	/**
	 * Find every canonical value of this type in the given
	 * text. Returns an empty array when the text contains
	 * no matches. Implementations should be tolerant of
	 * arbitrary input: HTML, markdown prose, frontmatter
	 * scalars, single short strings.
	 */
	matchAll(text: string): string[];
	/**
	 * Build a canonical URL from a stored value. Optional:
	 * types that have no clean URL form (e.g. a person
	 * identity) omit this. Returns `undefined` when the
	 * value cannot be encoded.
	 */
	url?(value: string): string | undefined;
	/**
	 * Why {@link url} could not encode this value, or nothing when it
	 * could.
	 *
	 * A separate method rather than a richer return from `url`, for the
	 * reason the same split exists over quest front matter: almost
	 * every caller wants a URL or nothing, and making all of them
	 * unwrap a result to get a string they already had would be a worse
	 * trade than one extra optional method here.
	 *
	 * It exists because a silent `undefined` is how 621 stored Slack
	 * refs came to produce no link with nothing anywhere saying so. The
	 * value was fine, the type was fine, and the two simply disagreed
	 * about the shape: written from API data as `CHANNEL/TIMESTAMP`,
	 * read back by a pattern wanting `workspace/CHANNEL/pTIMESTAMP`. A
	 * reason naming both shapes turns that from an invisible nothing
	 * into a thing somebody can fix.
	 *
	 * Implement it wherever `url` can decline. A type without it is
	 * saying its values never fail to encode, which is true of a type
	 * that has no URL form at all.
	 */
	whyNoUrl?(value: string): string | undefined;
}

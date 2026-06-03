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
}

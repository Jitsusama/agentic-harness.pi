/**
 * Types for the people library.
 *
 * An `Identity` is the canonical record for one person in
 * the user's world: a stable id, one or more names and a
 * set of handles (slack, github, email and so on). The
 * library stores one markdown file per identity and indexes
 * them in memory for fast lookup.
 *
 * A `Handle` is one (type, value) tuple. The `HandleType`
 * defines how to parse a freeform input string into a
 * canonical value, optionally how to find matches in
 * arbitrary text, and optionally how to build a URL.
 */

/** The canonical record for one person. */
export interface Identity {
	/**
	 * Stable identifier. Lowercase, kebab-case. Used as
	 * the registry filename ({id}.md) and as the
	 * cross-quest reference. Once chosen, never changes;
	 * renames go through a separate migration step.
	 */
	id: string;
	/**
	 * Display names. The first entry is the canonical
	 * full name; subsequent entries are aliases the tool
	 * uses for substring resolution.
	 */
	names: string[];
	/**
	 * All handles known for this identity, across types.
	 * Order is preserved on write.
	 */
	handles: Handle[];
}

/** One handle for an identity. */
export interface Handle {
	/** Handle type identifier (e.g. "slack", "github"). */
	type: string;
	/** The canonical value as parsed by the handle type. */
	value: string;
}

/**
 * A resolver looks an input handle, name or email up
 * against an external system and returns a candidate
 * identity, or undefined when the system has no answer.
 *
 * Resolvers run in priority order (lower numbers first);
 * the default priority is 100. Downstream packages
 * register their own resolvers ahead of the built-ins
 * (e.g. priority 50 for a Vault lookup) so they win when
 * both can resolve.
 *
 * Resolvers should not throw; integration errors and
 * missing answers both collapse to `undefined` so the
 * chain continues.
 */
export interface PersonResolver {
	/** Stable identifier, e.g. "slack", "vault". */
	id: string;
	/** Lower numbers run earlier. Default 100. */
	priority?: number;
	/**
	 * Resolve an input to an identity. Return `undefined`
	 * when this resolver has no answer (don't throw).
	 */
	resolve(input: string, opts?: ResolveOptions): Promise<Identity | undefined>;
}

/** Hints the caller passes to resolvers. */
export interface ResolveOptions {
	/** What the input looks like. Resolvers may ignore. */
	hint?: "name" | "handle" | "email";
	/** Abort signal for long-running lookups. */
	signal?: AbortSignal;
}

/**
 * What to do when no resolver can pin down a Cast bullet's
 * subject. `silent` records the bare name without ceremony,
 * `warn` records it but surfaces the gap in tool results,
 * `ask` surfaces it as a question for the user to answer.
 */
export type ResolutionFallback = "silent" | "warn" | "ask";

/** Pluggable definition of a handle type. */
export interface HandleType {
	/**
	 * Unique identifier for this type. Convention is
	 * lowercase: `"slack"`, `"github"`, `"email"`.
	 */
	type: string;
	/**
	 * Normalize one input string into the canonical handle
	 * value, or return `undefined` if the input doesn't
	 * fit. Should be tolerant: accept `"@joel"`, `"joel"`
	 * and `"Joel"` and normalize them all the same way.
	 */
	parse(text: string): string | undefined;
	/**
	 * Find handle values of this type in arbitrary text.
	 * Optional; used when extracting handles from prose
	 * (e.g. Slack thread bodies). Returns canonical
	 * values, possibly with duplicates dropped.
	 */
	matchAll?(text: string): string[];
	/**
	 * Build a canonical URL for this handle. Optional;
	 * not every handle type has a clean URL (email does,
	 * github does, slack only with a workspace context).
	 */
	url?(value: string): string | undefined;
}

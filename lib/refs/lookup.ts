/**
 * Refs lookup: read access into the registry plus parsing
 * helpers and URL building.
 *
 * `parseRef` is for short strings (an alias value, a single
 * link in a frontmatter scalar): it returns the first match
 * across registered types. `parseAllRefs` is for long
 * bodies of prose: it returns every match.
 */

import { get, list, parseAll } from "../internal/refs/registry.js";
import type { Ref, RefType } from "./types.js";

/** Look up a registered type by its identifier. */
export function getRefType(type: string): RefType | undefined {
	return get(type);
}

/** Snapshot of every registered type in registration order. */
export function listRefTypes(): RefType[] {
	return list();
}

/**
 * Parse a short text fragment as a single ref. Returns the
 * first match across registered types, walking the registry
 * in registration order. Returns `undefined` when nothing
 * matches.
 *
 * Use this for inputs the caller believes contains one ref
 * (an alias scalar, a CLI argument, a single line of text).
 * For longer prose use `parseAllRefs`.
 */
export function parseRef(text: string): Ref | undefined {
	for (const rt of list()) {
		const matches = rt.matchAll(text);
		if (matches.length > 0) return { type: rt.type, value: matches[0] };
	}
	return undefined;
}

/**
 * Parse a longer body of text and return every ref found
 * across registered types. Duplicate `{type, value}` pairs
 * are dropped. Order follows registration order across
 * types, then per-type match order within each.
 */
export function parseAllRefs(text: string): Ref[] {
	return parseAll(text);
}

/**
 * Build a canonical URL from a structured ref. Returns
 * `undefined` when the ref's type has no `url` function or
 * when the value cannot be encoded.
 */
export function urlForRef(ref: Ref): string | undefined {
	return get(ref.type)?.url?.(ref.value);
}

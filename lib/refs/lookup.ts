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
	const encoded = get(ref.type)?.url?.(ref.value);
	if (encoded !== undefined) return encoded;
	// A value that is already a link is its own link. Sweeping the live
	// store turned up refs under types nobody registered, several of
	// them holding a whole `https://` URL and rendering as no link at
	// all, which is absurd: `url: https://...` had a link in it the
	// entire time. This is the identity function rather than an
	// inference, so it invents nothing, and it runs second so a
	// registered type's own encoding always wins.
	return absoluteUrl(ref.value);
}

/** The value itself, when the value is already an http or https URL. */
function absoluteUrl(value: string): string | undefined {
	if (!/^https?:\/\//.test(value)) return undefined;
	try {
		return new URL(value).href === "" ? undefined : value;
	} catch {
		// Starts like a URL and is not one. Nothing to hand back, and
		// nothing worth complaining about either: an unregistered type
		// never promised a link.
		return undefined;
	}
}

/**
 * Why this ref has no URL, or nothing when it has one.
 *
 * The counterpart to {@link urlForRef}, kept separate for the same
 * reason the front-matter parser and its explainer are separate: most
 * callers want a link or nothing, and only the one rendering a list a
 * person reads has to account for the gap.
 *
 * Silence here is not the same as a missing link. A type with no URL
 * form at all, like a person identity, is not failing to encode
 * anything, so it says nothing and the caller shows no link and no
 * complaint. A type that could encode and did not is where the reason
 * comes from.
 */
export function whyRefHasNoUrl(ref: Ref): string | undefined {
	const type = get(ref.type);
	if (type?.url === undefined) return undefined;
	if (type.url(ref.value) !== undefined) return undefined;
	return (
		type.whyNoUrl?.(ref.value) ??
		// A type that can decline without explaining itself. Better than
		// nothing, and it names the type so somebody knows where to look.
		`"${ref.value}" is not a value the ${ref.type} type can turn into a link.`
	);
}

/**
 * Divert-to-disk: the uncapped form of any capped answer.
 *
 * A response has a byte budget; a file does not. Anything the
 * budget cannot carry inline goes to the session's bundle
 * directory whole, and the answer carries the path, so no
 * result is ever unobtainable, only relocated.
 */

import type { Paged } from "./paged.js";
import type { BundleSink } from "./sink.js";

/** How the whole list should read on disk. */
export interface ArtifactOptions<T> {
	/** File name to write under, before uniquing. */
	readonly name: string;
	/** How to render the artifact; JSON when the caller has no opinion. */
	readonly render?: (all: readonly T[]) => string;
}

/**
 * Names already written to each sink, so no divert clobbers
 * another. Keyed by the sink so the tally dies with the
 * session's bundle directory rather than growing for the life
 * of the process.
 */
const used = new WeakMap<BundleSink, Map<string, number>>();

/**
 * Write the whole list to the sink and return the same page
 * carrying the path, so the caller keeps its summary and its
 * window alongside the complete answer.
 */
export function withArtifact<T>(
	page: Paged<T>,
	all: readonly T[],
	sink: BundleSink,
	options: ArtifactOptions<T>,
): Paged<T> {
	const render = options.render ?? defaultRender;
	const artifactPath = sink.writeText(unique(sink, options.name), render(all));
	return { ...page, artifactPath };
}

/** A name no earlier divert to this sink has taken. */
function unique(sink: BundleSink, name: string): string {
	let taken = used.get(sink);
	if (!taken) {
		taken = new Map();
		used.set(sink, taken);
	}
	const seen = taken.get(name) ?? 0;
	taken.set(name, seen + 1);
	if (seen === 0) return name;

	const dot = name.lastIndexOf(".");
	return dot <= 0
		? `${name}-${seen + 1}`
		: `${name.slice(0, dot)}-${seen + 1}${name.slice(dot)}`;
}

/** The artifact when the caller names no format. */
function defaultRender(all: readonly unknown[]): string {
	return JSON.stringify(all, null, 2);
}

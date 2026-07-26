/**
 * Reading a source map, so a position in generated code can be
 * told where it came from.
 *
 * This is the one place in the library that reimplements
 * something rather than asking the browser, and the reason is
 * that the browser does not do it either. Chrome ships the
 * source map URL on Debugger.scriptParsed and CSS.styleSheetAdded
 * and stops there; resolving a position through the map is work
 * the devtools front end does for itself. There is no protocol
 * call to defer to.
 *
 * The format is a v3 source map: a run of base64 VLQ segments,
 * semicolons for generated lines, commas for segments within a
 * line, and every field after the first stored as a delta from
 * the previous segment.
 */

/** A source map as it arrives, before anything is decoded. */
export interface RawSourceMap {
	readonly version?: number;
	readonly file?: string;
	readonly sourceRoot?: string;
	readonly sources: readonly (string | null)[];
	readonly sourcesContent?: readonly (string | null)[];
	readonly names?: readonly string[];
	readonly mappings: string;
}

/** One decoded mapping segment. */
export interface Segment {
	/** Column in the generated file, zero based. */
	readonly generatedColumn: number;
	/** Index into the map's sources, absent for a bare segment. */
	readonly sourceIndex?: number;
	/** Line in the authored file, zero based. */
	readonly sourceLine?: number;
	/** Column in the authored file, zero based. */
	readonly sourceColumn?: number;
	/** Index into the map's names. */
	readonly nameIndex?: number;
}

/** A source map with its mappings decoded, ready to query. */
export interface SourceMap {
	readonly sources: readonly string[];
	readonly sourcesContent: readonly (string | null)[];
	readonly names: readonly string[];
	/** Segments per generated line, each sorted by column. */
	readonly lines: readonly (readonly Segment[])[];
}

/** Where a generated position came from. */
export interface AuthoredPosition {
	readonly source: string;
	/** Zero based, to match how the protocol counts. */
	readonly line: number;
	readonly column: number;
	/** The authored name, when the map recorded one. */
	readonly name?: string;
	/** The authored source's text, when the map carried it. */
	readonly content?: string;
}

const BASE64 =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const CHAR_VALUES = new Map<string, number>(
	[...BASE64].map((char, value) => [char, value]),
);

/** The low bit of a decoded VLQ carries the sign, not magnitude. */
const SIGN_BIT = 1;

/** Five bits of payload per character, the sixth is continuation. */
const PAYLOAD_BITS = 5;
const CONTINUATION = 1 << PAYLOAD_BITS;
const PAYLOAD_MASK = CONTINUATION - 1;

/**
 * Decode one comma-free run of base64 VLQ into its numbers.
 *
 * Returns nothing when the run contains a character outside the
 * alphabet, since a partly decoded segment is worse than an
 * absent one: it would point somewhere confidently wrong.
 */
export function decodeVlq(segment: string): number[] | undefined {
	const values: number[] = [];
	let accumulated = 0;
	let shift = 0;
	for (const char of segment) {
		const digit = CHAR_VALUES.get(char);
		if (digit === undefined) return undefined;
		accumulated += (digit & PAYLOAD_MASK) << shift;
		if (digit & CONTINUATION) {
			shift += PAYLOAD_BITS;
			continue;
		}
		const negative = (accumulated & SIGN_BIT) === SIGN_BIT;
		const magnitude = accumulated >> 1;
		values.push(negative ? -magnitude : magnitude);
		accumulated = 0;
		shift = 0;
	}
	// A trailing continuation means the run ended mid-number.
	return shift === 0 ? values : undefined;
}

/**
 * Decode a whole mappings string into segments by generated line.
 *
 * Every field but the generated column carries across lines,
 * which is why the running totals sit outside the line loop.
 */
export function decodeMappings(mappings: string): (readonly Segment[])[] {
	const lines: Segment[][] = [];
	let sourceIndex = 0;
	let sourceLine = 0;
	let sourceColumn = 0;
	let nameIndex = 0;

	for (const rawLine of mappings.split(";")) {
		const segments: Segment[] = [];
		// The generated column restarts at every line, unlike the rest.
		let generatedColumn = 0;
		for (const rawSegment of rawLine.split(",")) {
			if (rawSegment === "") continue;
			const fields = decodeVlq(rawSegment);
			if (!fields || fields.length === 0) continue;

			generatedColumn += fields[0] ?? 0;
			if (fields.length < 4) {
				// A one-field segment marks generated code with no
				// authored origin at all, which is a real answer.
				segments.push({ generatedColumn });
				continue;
			}
			sourceIndex += fields[1] ?? 0;
			sourceLine += fields[2] ?? 0;
			sourceColumn += fields[3] ?? 0;
			if (fields.length > 4) nameIndex += fields[4] ?? 0;
			segments.push({
				generatedColumn,
				sourceIndex,
				sourceLine,
				sourceColumn,
				...(fields.length > 4 ? { nameIndex } : {}),
			});
		}
		segments.sort((a, b) => a.generatedColumn - b.generatedColumn);
		lines.push(segments);
	}
	return lines;
}

/**
 * Prepare a raw map for querying.
 *
 * The source root is folded into each source here rather than at
 * lookup time, so every later answer is a path the caller can
 * use without knowing the map existed.
 */
export function readSourceMap(raw: RawSourceMap): SourceMap {
	const root = raw.sourceRoot ?? "";
	return {
		sources: raw.sources.map((source) => {
			const named = source ?? "(anonymous)";
			if (root === "") return named;
			return `${root.replace(/\/$/, "")}/${named.replace(/^\//, "")}`;
		}),
		sourcesContent: raw.sourcesContent ?? [],
		names: raw.names ?? [],
		lines: decodeMappings(raw.mappings),
	};
}

/**
 * Find where a generated position was authored.
 *
 * A map records the positions a compiler thought worth marking,
 * not every column, so a lookup takes the nearest mapping at or
 * before the column asked for. That is what makes a stack frame
 * pointing into the middle of a minified expression resolve to
 * the statement it belongs to.
 */
export function authoredPosition(
	map: SourceMap,
	generated: { readonly line: number; readonly column: number },
): AuthoredPosition | undefined {
	const segments = map.lines[generated.line];
	if (!segments || segments.length === 0) return undefined;

	let found: Segment | undefined;
	for (const segment of segments) {
		if (segment.generatedColumn > generated.column) break;
		found = segment;
	}
	// Before the first mapping on the line there is nothing to say.
	if (!found || found.sourceIndex === undefined) return undefined;

	const source = map.sources[found.sourceIndex];
	if (source === undefined) return undefined;
	const content = map.sourcesContent[found.sourceIndex];
	const name =
		found.nameIndex === undefined ? undefined : map.names[found.nameIndex];

	return {
		source,
		line: found.sourceLine ?? 0,
		column: found.sourceColumn ?? 0,
		...(name === undefined ? {} : { name }),
		...(content === undefined || content === null ? {} : { content }),
	};
}

/**
 * Work out where a map lives, given the file that named it.
 *
 * A map URL is usually relative to the file that references it,
 * and is sometimes the map itself inlined as a data URL, which
 * needs no fetching at all.
 */
export function resolveMapUrl(
	fileUrl: string,
	sourceMapUrl: string,
):
	| { readonly kind: "inline"; readonly json: string }
	| { readonly kind: "fetch"; readonly url: string }
	| undefined {
	if (sourceMapUrl.startsWith("data:")) {
		const comma = sourceMapUrl.indexOf(",");
		if (comma < 0) return undefined;
		const meta = sourceMapUrl.slice(0, comma);
		const payload = sourceMapUrl.slice(comma + 1);
		if (!meta.includes(";base64")) {
			return { kind: "inline", json: decodeURIComponent(payload) };
		}
		try {
			return {
				kind: "inline",
				json: Buffer.from(payload, "base64").toString("utf8"),
			};
		} catch {
			// A malformed data URL is not worth a thrown error; the
			// caller simply reports the generated position instead.
			return undefined;
		}
	}
	try {
		return { kind: "fetch", url: new URL(sourceMapUrl, fileUrl).toString() };
	} catch {
		// Relative resolution fails when the file URL is not a URL,
		// which happens for eval'd script with no origin.
		return undefined;
	}
}

/** Read a map's JSON, refusing anything that is not one. */
export function parseSourceMap(json: string): SourceMap | undefined {
	try {
		const raw: unknown = JSON.parse(json);
		if (
			typeof raw !== "object" ||
			raw === null ||
			!("mappings" in raw) ||
			typeof (raw as RawSourceMap).mappings !== "string" ||
			!Array.isArray((raw as RawSourceMap).sources)
		) {
			return undefined;
		}
		return readSourceMap(raw as RawSourceMap);
	} catch {
		// Not JSON at all, which usually means the map URL 404'd and
		// a server returned an HTML error page.
		return undefined;
	}
}

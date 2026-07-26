/**
 * Telling a position in generated code where it was authored.
 *
 * The browser reports which map belongs to a script or a
 * stylesheet and then leaves the resolving to whoever is asking,
 * so this is the one corner of the library that decodes a format
 * itself rather than deferring to a protocol call.
 */

export {
	type AuthoredPosition,
	authoredPosition,
	decodeMappings,
	decodeVlq,
	parseSourceMap,
	type RawSourceMap,
	readSourceMap,
	resolveMapUrl,
	type Segment,
	type SourceMap,
} from "./mappings.js";

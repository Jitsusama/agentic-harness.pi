/**
 * Column translation between the tool's UTF-8 byte columns
 * and LSP's UTF-16 code-unit columns, both 0-indexed.
 *
 * A JavaScript string is already a sequence of UTF-16 code
 * units, so `ch.length` gives a code point's unit width (1
 * or 2). The byte width comes from the code point's value.
 */

function utf8ByteLength(codePoint: number): number {
	if (codePoint < 0x80) return 1;
	if (codePoint < 0x800) return 2;
	if (codePoint < 0x10000) return 3;
	return 4;
}

/**
 * Map a 0-indexed UTF-8 byte column to its 0-indexed UTF-16
 * code-unit column. A byte column past the line's end clamps
 * to the line's unit length; one that lands inside a
 * multi-byte character rounds up to the next boundary.
 */
export function byteToUtf16(lineText: string, byteColumn: number): number {
	let bytes = 0;
	let units = 0;
	for (const ch of lineText) {
		if (bytes >= byteColumn) return units;
		bytes += utf8ByteLength(ch.codePointAt(0) ?? 0);
		units += ch.length;
	}
	return units;
}

/**
 * Map a 0-indexed UTF-16 code-unit column to its 0-indexed
 * UTF-8 byte column. A unit column past the line's end
 * clamps to the line's byte length; one that lands inside a
 * surrogate pair rounds up to the next boundary.
 */
export function utf16ToByte(lineText: string, utf16Column: number): number {
	let units = 0;
	let bytes = 0;
	for (const ch of lineText) {
		if (units >= utf16Column) return bytes;
		units += ch.length;
		bytes += utf8ByteLength(ch.codePointAt(0) ?? 0);
	}
	return bytes;
}

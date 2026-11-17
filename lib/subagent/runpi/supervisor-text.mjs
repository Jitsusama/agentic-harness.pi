/**
 * How the supervisor cuts text down to what it keeps: an answer to its
 * byte cap, stderr to its tail, a stream line or a tool's argument to a
 * glance, and a failed read to its code.
 *
 * Plain `.mjs`, as the supervisor is, because node runs that script
 * directly and won't strip types under `node_modules`.
 */

/**
 * Cut text to `maxBytes` of UTF-8, never splitting a character, and
 * say so through `warn` when it was cut.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @param {(message: string) => void} warn
 */
export function truncateBytes(text, maxBytes, warn) {
	// Reached once per delta now that a message is read while it is
	// still being written, so the common case must not measure. A
	// character is at most four bytes, so anything this short fits.
	if (text.length * 4 <= maxBytes) return text;
	if (Buffer.byteLength(text) <= maxBytes) return text;
	warn(`Reviewer assistant text exceeded ${maxBytes} bytes; truncated`);
	// Cut in the bytes and stepped back off a continuation byte, so a
	// multi-byte character is never split. Shortening by one character
	// and re-measuring the whole string is quadratic in the length.
	const held = Buffer.from(text, "utf8");
	let at = maxBytes;
	while (at > 0 && ((held[at] ?? 0) & 0xc0) === 0x80) at--;
	return held.subarray(0, at).toString("utf8");
}

/**
 * The first `max` characters of text, marked with `...` when cut.
 *
 * @param {string} text
 * @param {number} max
 */
export function truncate(text, max) {
	return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * The longest end of text that fits in `maxBytes` of UTF-8.
 *
 * @param {string} text
 * @param {number} maxBytes
 */
export function tail(text, maxBytes) {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	// Cut in the bytes and stepped forward off a continuation byte, so
	// a character is never split, as truncateBytes steps back. Walking
	// back a UTF-16 unit at a time could split a four-byte character,
	// and never tried the cut after the first character.
	const held = Buffer.from(text, "utf8");
	let at = held.length - maxBytes;
	while (at < held.length && ((held[at] ?? 0) & 0xc0) === 0x80) at++;
	return held.subarray(at).toString("utf8");
}

/**
 * A value on one line, its runs of white space made one space, cut to
 * `max` characters with an ellipsis.
 *
 * @param {unknown} value
 * @param {number} max
 */
export function trim(value, max) {
	const clean = String(value).replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * What a failed read says it was, by its code where it has one.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function errorCode(error) {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? error.code
			: undefined;
	return typeof code === "string" ? code : String(error);
}

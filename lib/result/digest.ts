/**
 * Saying what a payload is shaped like, in a few hundred bytes.
 *
 * A handle on its own is a locked door: the caller knows the
 * payload exists but not what to ask it. A digest is the label on
 * the door, and it has to stay small whether it describes ten
 * records or ten million, so every dimension that could grow with
 * the input is bounded independently: depth, keys per object,
 * elements profiled, and the final byte count.
 *
 * What it deliberately does not do is sample. A field's value
 * profile is either over the whole array or replaced by the
 * length and a first-element shape, never a partial scan
 * presented as a total, because a caller who queries on the
 * strength of a wrong profile has been misled by the thing meant
 * to orient them.
 */

/** Budgets that keep a summary bounded regardless of the input's size. */
export interface JsonSummaryOptions {
	maxKeys?: number;
	maxDepth?: number;
	maxBytes?: number;
	maxElements?: number;
	/** Render the shape across indented lines instead of one compact line. */
	pretty?: boolean;
}

const DEFAULT_MAX_KEYS = 40;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_BYTES = 6000;
// The pretty form spends bytes on newlines and indentation, so it gets a larger
// cap: it is a terminal-only view a human reads on demand, never model context.
const DEFAULT_PRETTY_MAX_BYTES = 20000;
// Above this many array elements the profile stops tallying values and falls
// back to a first-element sample. Tallying is linear in element count, so this
// keeps the walk bounded no matter how large the parsed payload is, and it means
// a reported value count is always over the whole array, never a partial scan
// dressed up as exact. Every realistic result sits far below it.
const DEFAULT_MAX_ELEMENTS = 20000;
// How a profiled field's values are rendered: at most this many distinct values
// listed before folding the rest into a "(+N more)" tail, and above the high
// cardinality cutoff no values are listed at all, only the type and the distinct
// count, so an id-like field opts itself out instead of listing noise. Long
// scalar values are clipped so one value cannot dominate the summary.
const TOP_VALUES = 6;
const HIGH_CARDINALITY = 50;
const MAX_VALUE_LEN = 24;

/**
 * Render a bounded structural summary of a parsed JSON value.
 *
 * An object becomes its keys mapped to value profiles, an array of objects
 * becomes its length plus a per-key value-frequency profile, and a scalar
 * becomes its type. Recursion stops at `maxDepth`, only `maxKeys` keys are shown
 * before the rest are counted, arrays past `maxElements` degrade to a sample so
 * the walk stays bounded, and the whole string is capped at `maxBytes`. With
 * `pretty` the same shape is laid out across indented lines for a human to read.
 */
export function summarizeJson(
	value: unknown,
	opts: JsonSummaryOptions = {},
): string {
	const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
	const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
	const pretty = opts.pretty ?? false;
	const maxBytes =
		opts.maxBytes ?? (pretty ? DEFAULT_PRETTY_MAX_BYTES : DEFAULT_MAX_BYTES);
	return capBytes(
		describe(value, 0, maxDepth, maxKeys, maxElements, pretty),
		maxBytes,
	);
}

/** The indentation for a given nesting depth in the pretty layout. */
function pad(depth: number): string {
	return "  ".repeat(depth);
}

function describe(
	value: unknown,
	depth: number,
	maxDepth: number,
	maxKeys: number,
	maxElements: number,
	pretty: boolean,
): string {
	if (value === null) return "null";
	if (Array.isArray(value))
		return describeArray(value, depth, maxDepth, maxKeys, maxElements, pretty);
	if (typeof value === "object")
		return describeObject(
			value as Record<string, unknown>,
			depth,
			maxDepth,
			maxKeys,
			maxElements,
			pretty,
		);
	if (typeof value === "string") return `string(${value.length})`;
	return typeof value;
}

function describeArray(
	value: unknown[],
	depth: number,
	maxDepth: number,
	maxKeys: number,
	maxElements: number,
	pretty: boolean,
): string {
	if (value.length === 0) return "array(0)";
	if (depth >= maxDepth) return `array(${value.length})`;
	// Past the element bound, sample the first element instead of tallying: the
	// count is too large to profile without an unbounded walk, so show the shape
	// and let the handle carry the detail a query can pull.
	if (value.length > maxElements) {
		const first = describe(
			value[0],
			depth + 1,
			maxDepth,
			maxKeys,
			maxElements,
			pretty,
		);
		return `array(${value.length}, first=${first})`;
	}
	if (value.every(isScalar))
		return `array(${value.length}) of ${profileScalars(value)}`;
	if (value.every(isPlainObject))
		return `array(${value.length}) of {${profileObjectArray(value, depth, maxKeys, pretty)}}`;
	const first = describe(
		value[0],
		depth + 1,
		maxDepth,
		maxKeys,
		maxElements,
		pretty,
	);
	return `array(${value.length}, first=${first})`;
}

/** A JSON scalar for profiling: a primitive or null, never an object or array. */
function isScalar(value: unknown): boolean {
	return value === null || typeof value !== "object";
}

/** A plain (non-array) object, the shape the object-array profile expects. */
function isPlainObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Profile an array of objects: each key mapped to a profile of its values. */
function profileObjectArray(
	rows: unknown[],
	depth: number,
	maxKeys: number,
	pretty: boolean,
): string {
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const row of rows)
		for (const key of Object.keys(row as Record<string, unknown>))
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
	const shown = keys.slice(0, maxKeys);
	const parts = shown.map((key) => {
		const values = rows
			.map((row) => (row as Record<string, unknown>)[key])
			.filter((v) => v !== undefined);
		return `${key}: ${describeField(values, rows.length)}`;
	});
	const rest = keys.length - shown.length;
	if (rest > 0) parts.push(`(+${rest} more)`);
	return joinEntries(parts, depth, pretty);
}

/**
 * Profile a field, saying so when it is missing rather than saying
 * nothing.
 *
 * A field can appear in the key set and hold a value on no record at
 * all, and profiling only the values that exist then produced an
 * empty string: "threadTs: " followed by the next field. A reader
 * cannot tell from that whether the field is empty, absent, or a
 * rendering fault, and it looks most like the last one. Real Slack
 * data is where it showed up, since a message outside a thread
 * carries neither a thread timestamp nor a reply count.
 *
 * Partial absence is worth the same honesty: a field carried by
 * half the records is a different shape from one carried by all of
 * them, and a query written against the first will come back
 * shorter than expected for a reason the digest could have named.
 */
function describeField(values: unknown[], rows: number): string {
	if (values.length === 0) return `absent on all ${rows}`;
	const missing = rows - values.length;
	const profile = profileField(values);
	return missing > 0 ? `${profile}, absent×${missing}` : profile;
}

/** Profile one field's collected values: scalars by frequency, else by type. */
function profileField(values: unknown[]): string {
	if (values.every(isScalar)) return profileScalars(values);
	if (values.every(isPlainObject)) return "object";
	if (values.every(Array.isArray)) return "array";
	return "mixed";
}

/**
 * Profile a list of scalar values by frequency. Below the cardinality cutoff the
 * most common values are listed with their counts; above it only the type and
 * the distinct count are shown so a high-cardinality field stays compact.
 */
function profileScalars(values: unknown[]): string {
	const counts = new Map<string, { value: unknown; count: number }>();
	for (const value of values) {
		const key = JSON.stringify(value) ?? "null";
		const entry = counts.get(key);
		if (entry) entry.count++;
		else counts.set(key, { value, count: 1 });
	}
	if (counts.size > HIGH_CARDINALITY)
		return `${scalarType(values)} (${counts.size} distinct)`;
	const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
	const listed = ranked
		.slice(0, TOP_VALUES)
		.map((e) =>
			e.count > 1 ? `${display(e.value)}×${e.count}` : display(e.value),
		)
		.join(", ");
	const rest = ranked.length - TOP_VALUES;
	return rest > 0 ? `${listed}, (+${rest} more)` : listed;
}

/** The shared type name of a list of scalars, or "mixed" when they disagree. */
function scalarType(values: unknown[]): string {
	const types = new Set(values.map((v) => (v === null ? "null" : typeof v)));
	return types.size === 1 ? [...types][0] : "mixed";
}

/** Render a scalar value for display, clipping a long string so it cannot dominate. */
function display(value: unknown): string {
	if (typeof value !== "string") return String(value);
	return value.length > MAX_VALUE_LEN
		? `${value.slice(0, MAX_VALUE_LEN)}...`
		: value;
}

function describeObject(
	value: Record<string, unknown>,
	depth: number,
	maxDepth: number,
	maxKeys: number,
	maxElements: number,
	pretty: boolean,
): string {
	const keys = Object.keys(value);
	if (depth >= maxDepth) return `object(${keys.length} keys)`;
	const shown = keys.slice(0, maxKeys);
	const parts = shown.map(
		(key) =>
			`${key}: ${describe(value[key], depth + 1, maxDepth, maxKeys, maxElements, pretty)}`,
	);
	const rest = keys.length - shown.length;
	if (rest > 0) parts.push(`(+${rest} more)`);
	return `{${joinEntries(parts, depth, pretty)}}`;
}

/**
 * Join the entries of an object or object-array profile. Compact form runs them
 * on one line; pretty form puts each on its own indented line so a human can
 * scan the shape, with the closing brace back at the parent's indentation.
 */
function joinEntries(parts: string[], depth: number, pretty: boolean): string {
	if (!pretty) return parts.join(", ");
	if (parts.length === 0) return "";
	const inner = pad(depth + 1);
	return `\n${parts.map((part) => inner + part).join("\n")}\n${pad(depth)}`;
}

/** Hard-cap a summary to `maxBytes`, cutting on a character boundary and marking the cut. */
function capBytes(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= maxBytes) return text;
	const marker = "...";
	const budget = Math.max(0, maxBytes - marker.length);
	let end = budget;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.toString("utf-8", 0, end) + marker;
}

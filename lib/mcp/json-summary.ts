import type { SpillTarget } from "./ceiling.js";
import type { McpContent } from "./types.js";

/** Budgets that keep a JSON summary bounded regardless of the input's size. */
export interface JsonSummaryOptions {
	maxKeys?: number;
	maxDepth?: number;
	maxBytes?: number;
}

const DEFAULT_MAX_KEYS = 40;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_BYTES = 6000;
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
 * An object becomes its top-level keys mapped to value types, an array becomes
 * its length with a sample of the first element, and a scalar becomes its type
 * (with the length, for a string). Recursion stops at `maxDepth`, only `maxKeys`
 * object keys are shown before the rest are counted, and the whole string is
 * hard-capped at `maxBytes` so the summary can never itself blow the budget.
 */
export function summarizeJson(
	value: unknown,
	opts: JsonSummaryOptions = {},
): string {
	const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
	const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	return capBytes(describe(value, 0, maxDepth, maxKeys), maxBytes);
}

/** Inputs for turning an oversized JSON payload into a summary plus a stored handle. */
export interface JsonSummaryContentOptions {
	rawText: string;
	spill: (text: string) => SpillTarget;
	parseGateBytes: number;
	summary?: JsonSummaryOptions;
}

/**
 * Turn an oversized JSON payload into model-facing content: a bounded shape
 * summary and a notice naming the stored handle. Returns undefined when the
 * payload is larger than the parse gate or does not parse as JSON, so the
 * caller can fall back to the absolute ceiling.
 */
export function jsonSummaryContent(
	opts: JsonSummaryContentOptions,
): McpContent[] | undefined {
	if (Buffer.byteLength(opts.rawText, "utf-8") > opts.parseGateBytes)
		return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(opts.rawText);
	} catch {
		return undefined;
	}
	// Fail closed: if the payload cannot be stored, decline so the caller falls
	// back to the absolute ceiling rather than crashing the tool call.
	let target: SpillTarget;
	try {
		target = opts.spill(opts.rawText);
	} catch {
		return undefined;
	}
	const summary = summarizeJson(parsed, opts.summary);
	const where = target.handle
		? `handle ${target.handle} (${target.path})`
		: target.path;
	return [
		{ type: "text", text: `JSON result summary:\n${summary}` },
		{
			type: "text",
			text:
				`[Full JSON stashed under ${where}; available this session. ` +
				"Query it with a JSONPath expression that projects the fields you need " +
				"(e.g. $.events[0:20].id), rather than $.events[*], which returns whole " +
				"records. A query returns a bounded number of matches and reports the " +
				'total match count, so a broad expression still answers "how many".]',
		},
	];
}

function describe(
	value: unknown,
	depth: number,
	maxDepth: number,
	maxKeys: number,
): string {
	if (value === null) return "null";
	if (Array.isArray(value))
		return describeArray(value, depth, maxDepth, maxKeys);
	if (typeof value === "object")
		return describeObject(
			value as Record<string, unknown>,
			depth,
			maxDepth,
			maxKeys,
		);
	if (typeof value === "string") return `string(${value.length})`;
	return typeof value;
}

function describeArray(
	value: unknown[],
	depth: number,
	maxDepth: number,
	maxKeys: number,
): string {
	if (value.length === 0) return "array(0)";
	if (depth >= maxDepth) return `array(${value.length})`;
	if (value.every(isScalar))
		return `array(${value.length}) of ${profileScalars(value)}`;
	if (value.every(isPlainObject))
		return `array(${value.length}) of {${profileObjectArray(value, maxKeys)}}`;
	const first = describe(value[0], depth + 1, maxDepth, maxKeys);
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
function profileObjectArray(rows: unknown[], maxKeys: number): string {
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
		return `${key}: ${profileField(values)}`;
	});
	const rest = keys.length - shown.length;
	if (rest > 0) parts.push(`(+${rest} more)`);
	return parts.join(", ");
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
): string {
	const keys = Object.keys(value);
	if (depth >= maxDepth) return `object(${keys.length} keys)`;
	const shown = keys.slice(0, maxKeys);
	const parts = shown.map(
		(key) => `${key}: ${describe(value[key], depth + 1, maxDepth, maxKeys)}`,
	);
	const rest = keys.length - shown.length;
	if (rest > 0) parts.push(`(+${rest} more)`);
	return `{${parts.join(", ")}}`;
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

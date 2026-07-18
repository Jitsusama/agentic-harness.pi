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
const DEFAULT_MAX_BYTES = 2000;

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
	const target = opts.spill(opts.rawText);
	const summary = summarizeJson(parsed, opts.summary);
	const where = target.handle
		? `handle ${target.handle} (${target.path})`
		: target.path;
	return [
		{ type: "text", text: `JSON result summary:\n${summary}` },
		{
			type: "text",
			text: `[Full JSON saved under ${where}. Query it with a JSONPath expression, or read the file, for the full data.]`,
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
	const first = describe(value[0], depth + 1, maxDepth, maxKeys);
	return `array(${value.length}, first=${first})`;
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

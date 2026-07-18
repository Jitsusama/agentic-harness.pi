import { JSONPath } from "jsonpath-plus";
import {
	DEFAULT_RESULT_CEILING_BYTES,
	enforceResultCeiling,
} from "./ceiling.js";
import { HandleExpiredError, type ResultStore } from "./store.js";
import type { McpContent } from "./types.js";

/** Bounds on a query's answer: the byte ceiling and the maximum matches returned. */
export interface QueryOptions {
	limitBytes?: number;
	maxMatches?: number;
}

const DEFAULT_MAX_MATCHES = 100;

/**
 * Run a JSONPath expression against a stored JSON payload and return the matched
 * slice as JSON text.
 *
 * The answer is bounded twice: at most `maxMatches` matches are serialized, and
 * the serialized text passes back through the absolute ceiling (spilling to the
 * same store) so a broad query cannot re-inflate the context. An unknown or
 * expired handle, a payload that no longer parses, or an invalid expression each
 * return an explanatory text block rather than throwing.
 */
export function queryStoredJson(
	store: ResultStore,
	handle: string,
	expression: string,
	opts: QueryOptions = {},
): McpContent[] {
	let rawText: string;
	try {
		rawText = store.read(handle);
	} catch (err) {
		if (err instanceof HandleExpiredError) return note(err.message);
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch {
		return note(`stored result for handle ${handle} is not valid JSON`);
	}

	let matches: unknown[];
	try {
		matches = JSONPath({
			path: expression,
			json: parsed as string | number | boolean | object | null,
			wrap: true,
		}) as unknown[];
	} catch (err) {
		return note(
			`invalid JSONPath expression: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (matches.length === 0)
		return note(`no matches for expression ${expression}`);

	const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
	const limited = matches.slice(0, maxMatches);
	const answer: McpContent[] = [
		{ type: "text", text: JSON.stringify(limited, null, 2) },
	];

	return enforceResultCeiling(
		answer,
		{ content: answer },
		{
			limitBytes: opts.limitBytes ?? DEFAULT_RESULT_CEILING_BYTES,
			spill: (text) => store.put(text),
		},
	);
}

/** A single-block explanatory result for a query that could not run. */
function note(message: string): McpContent[] {
	return [{ type: "text", text: `[${message}]` }];
}

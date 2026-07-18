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
const MAX_EXPRESSION_ECHO = 200;

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
			// Filter expressions are the most useful query verb, so evaluation stays
			// on. The expression is authored by the frontend model, which can already
			// run arbitrary code through bash, so JSONPath eval grants it no new
			// capability; the try/catch below keeps a malformed expression from
			// throwing, which is robustness rather than a security boundary.
			eval: true,
		}) as unknown[];
	} catch (err) {
		return note(
			`invalid JSONPath expression: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (matches.length === 0)
		return note(`no matches for expression ${echo(expression)}`);

	const maxMatches = Math.max(0, opts.maxMatches ?? DEFAULT_MAX_MATCHES);
	const limited = matches.slice(0, maxMatches);
	// Report the full match count before truncation so a broad expression answers
	// "how many" for free: the model reads the count without pulling every record.
	const header =
		limited.length < matches.length
			? `${matches.length} matches; showing the first ${limited.length}.`
			: `${matches.length} matches.`;
	const answer: McpContent[] = [
		{ type: "text", text: header },
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

/** A single-block explanatory result for a query that could not run, itself bounded. */
function note(message: string): McpContent[] {
	return [{ type: "text", text: `[${echo(message)}]` }];
}

/** Bound a model-supplied string echoed back into a message so it cannot itself bloat the result. */
function echo(text: string): string {
	return text.length > MAX_EXPRESSION_ECHO
		? `${text.slice(0, MAX_EXPRESSION_ECHO)}...`
		: text;
}

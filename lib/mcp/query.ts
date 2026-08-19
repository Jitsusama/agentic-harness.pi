/**
 * Querying a stored MCP payload.
 *
 * The query language and its bounds are general and live in
 * agentic-harness.core's result module. What stays here is the MCP shape of the answer:
 * content blocks, and the absolute ceiling that can send an
 * over-broad answer straight back to the store it came from.
 */

import {
	DEFAULT_MAX_MATCHES,
	type QueryOptions,
	queryStored,
} from "@jitsusama/agentic-harness.core/result";
import {
	DEFAULT_RESULT_CEILING_BYTES,
	enforceResultCeiling,
} from "./ceiling.js";
import type { ResultStore } from "./store.js";
import type { McpContent } from "./types.js";

export type { QueryOptions } from "@jitsusama/agentic-harness.core/result";

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
	const answer = queryStored(store, handle, expression, {
		maxMatches: opts.maxMatches ?? DEFAULT_MAX_MATCHES,
	});
	const blocks: McpContent[] = answer.blocks.map((block) => ({
		type: "text",
		text: block.text,
	}));

	return enforceResultCeiling(
		blocks,
		{ content: blocks },
		{
			limitBytes: opts.limitBytes ?? DEFAULT_RESULT_CEILING_BYTES,
			spill: (text) => store.put(text),
			guidance:
				"To get a smaller result, project fewer fields or add a filter to your JSONPath expression.",
		},
	);
}

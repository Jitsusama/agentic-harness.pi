/**
 * An oversized MCP result as a summary plus a stored handle.
 *
 * The digest and the store are general and live in `lib/result`;
 * what stays here is the part that knows about MCP: content
 * blocks, and the terminal-only view that rides on
 * structuredContent where the renderer can read it and the model
 * cannot.
 */

import { type JsonSummaryOptions, summarizeJson } from "../result/digest.js";
import type { SpillTarget } from "./ceiling.js";
import type { McpContent } from "./types.js";

export { type JsonSummaryOptions, summarizeJson } from "../result/digest.js";

/** Inputs for turning an oversized JSON payload into a summary plus a stored handle. */
export interface JsonSummaryContentOptions {
	rawText: string;
	spill: (text: string) => SpillTarget;
	parseGateBytes: number;
	summary?: JsonSummaryOptions;
}

/** The key under which the terminal-only render view rides on structuredContent. */
export const RESULT_VIEW_KEY = "__mcpResultView";

/**
 * A terminal-only view of a summarized result. It travels on structuredContent,
 * which the renderer reads but the model never sees, so it can hold a fuller,
 * friendlier shape than the compact digest handed to the model.
 */
export interface ResultView {
	/** The multi-line, indented shape shown when the result is expanded. */
	pretty: string;
	/** The stored handle, when the payload was stashed behind one. */
	handle?: string;
	/** Where the full payload landed on disk. */
	path: string;
	/** The size of the full payload in bytes. */
	bytes: number;
}

/** The model-facing content plus the terminal-only view for a summarized result. */
export interface JsonSummaryResult {
	content: McpContent[];
	view: ResultView;
}

/**
 * Turn an oversized JSON payload into model-facing content and a terminal view.
 *
 * The content is a compact shape summary and a notice naming the stored handle,
 * exactly what the model receives. The view carries a friendlier multi-line
 * shape for the terminal, laid out from the same parse. Returns undefined when
 * the payload is larger than the parse gate or does not parse as JSON, so the
 * caller can fall back to the absolute ceiling.
 */
export function jsonSummaryContent(
	opts: JsonSummaryContentOptions,
): JsonSummaryResult | undefined {
	const bytes = Buffer.byteLength(opts.rawText, "utf-8");
	if (bytes > opts.parseGateBytes) return undefined;
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
	const pretty = summarizeJson(parsed, { ...opts.summary, pretty: true });
	const where = target.handle
		? `handle ${target.handle} (${target.path})`
		: target.path;
	const content: McpContent[] = [
		{ type: "text", text: `JSON result summary:\n${summary}` },
		{
			type: "text",
			text:
				`[Full JSON stashed under ${where}; available this session. ` +
				"Query it with a JSONPath expression that projects the fields you need " +
				"(e.g. $.events[0:20].id), rather than $.events[*], which returns whole " +
				"records. A field name containing dots is a single literal key, so match " +
				"it with bracket notation like $.events[?(@['a.b.c']=='x')]. A query " +
				"returns a bounded number of matches and reports the total match count, " +
				'so a broad expression still answers "how many".]',
		},
	];
	return {
		content,
		view: { pretty, handle: target.handle, path: target.path, bytes },
	};
}

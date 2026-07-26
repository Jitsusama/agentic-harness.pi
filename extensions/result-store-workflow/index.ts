/**
 * One query language over every tool's stored output.
 *
 * Tools in this package that can answer with a large payload keep
 * the whole payload on disk and hand back a bounded view plus a
 * handle. This extension is the other half of that bargain: the
 * tool that turns a handle back into an answer, and the session
 * lifetime that decides how long a handle is worth citing.
 *
 * It is one tool rather than one per family because the cost of a
 * query language is learning it, and that cost is only paid once
 * if the language does not change depending on who stored the
 * payload. A browser page outline, a Slack thread and a
 * language-server reference list are all queried the same way.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	cleanupSessionResults,
	DEFAULT_MAX_MATCHES,
	isPidAlive,
	queryStored,
	RESULT_ROOT,
	reapAbandonedResults,
} from "../../lib/result/index.js";
import { renderQueryCall, renderQueryResult } from "./render.js";
import { forgetSessionStore, sessionStore } from "./store.js";

/** What the tool reports alongside its text, for the renderers. */
export interface QueryDetails {
	readonly handle: string;
	readonly expression: string;
	/** Total matches before any cap, absent when the query could not run. */
	readonly matches?: number;
}

export default function resultStore(pi: ExtensionAPI) {
	pi.registerTool({
		name: "result_query",
		label: "Query Result",
		description:
			"Query a stored tool output with a JSONPath expression. Tools that " +
			"answer with more than they can show cite a handle; this reads the " +
			"rest. Project the fields you need (e.g. $.nodes[0:20].name) or " +
			"filter first (e.g. $.requests[?(@.status==500)].url) rather than " +
			"$.nodes[*], which returns whole records. The reply reports the " +
			"total match count before truncation, so a broad expression answers " +
			'"how many" without pulling every record.',
		promptSnippet:
			"Query a stored tool output by handle with a JSONPath expression.",
		promptGuidelines: [
			"When a tool answer cites a handle, query it rather than re-running the tool with different arguments.",
			"Project or filter to keep the reply small: $.items[0:20].name, not $.items[*].",
			"A broad expression reports the total match count, which is the cheapest way to answer 'how many'.",
			"Field names are case-sensitive, and a field name containing dots is a single literal key: match it with bracket notation like @['a.b.c'].",
		],
		parameters: Type.Object({
			handle: Type.String({
				description:
					"The handle from a tool answer's citation, e.g. result-1a2b3c4d5e6f7a8b.",
			}),
			expression: Type.String({
				description:
					"A JSONPath expression. Project or filter to keep the reply " +
					"small, e.g. $.nodes[0:20].name or " +
					"$.requests[?(@.status==500)].url.",
			}),
			maxMatches: Type.Optional(
				Type.Number({
					description: `Cap on matches returned. Defaults to ${DEFAULT_MAX_MATCHES}. The total is always reported, however many are shown.`,
				}),
			),
		}),

		renderCall(args, theme) {
			return renderQueryCall(args, theme);
		},

		renderResult(result, state, theme) {
			return renderQueryResult(result, state, theme);
		},

		async execute(_toolCallId, params) {
			const answer = queryStored(
				sessionStore(),
				params.handle,
				params.expression,
				params.maxMatches === undefined
					? {}
					: { maxMatches: params.maxMatches },
			);
			return {
				content: answer.blocks.map((block) => ({
					type: "text" as const,
					text: block.text,
				})),
				details: {
					handle: params.handle,
					expression: params.expression,
					...(answer.matches === undefined ? {} : { matches: answer.matches }),
				} satisfies QueryDetails,
			};
		},
	});

	pi.on("session_start", async () => {
		// A session that was killed cannot clean up after itself, and a
		// pid-named directory whose process is gone is unambiguously
		// abandoned, so this is where those get collected.
		reapAbandonedResults({ root: RESULT_ROOT, isPidAlive });
	});

	pi.on("session_shutdown", async () => {
		cleanupSessionResults();
		forgetSessionStore();
	});
}

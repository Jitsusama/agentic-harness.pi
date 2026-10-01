/**
 * Session Recall Workflow extension.
 *
 * A compaction leaves a summary and a recent tail in the context, and
 * everything else on disk. `session_recall` searches that log or reads
 * one entry of it by id, so what the summary left out is still one
 * call away rather than gone. Replays of real sessions answered
 * questions about earlier work better with it than without, over and
 * above whichever summary they had.
 *
 * Every summary the harness writes says the tool exists, through the
 * compaction workflow's contributions: a model that has just lost its
 * history has no other reason to go looking for it.
 *
 * A page is bounded, since recall lands in the room a compaction just
 * made. What the page leaves out is stored through the result store
 * and cited by handle, so a long entry or a long list of hits is never
 * silently cut.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	citeListing,
	openSessionStore,
} from "@jitsusama/agentic-harness.core/result";
import { Type } from "@sinclair/typebox";
import {
	isSummaryContributions,
	SUMMARY_CONTRIBUTIONS,
} from "../../lib/compaction/index.ts";
import {
	PAGE_CHARS,
	RECALL_TOOL,
	type Recalled,
	recall,
} from "../../lib/internal/recall/session.ts";

/** What every summary says about the tool, appended after its text. */
export const RECALL_NOTE =
	"\n\nThe complete session before this point is still on disk: " +
	`${RECALL_TOOL} can search it, or read any entry of it by id or by ` +
	"a quote's p: reference.";

/**
 * Room for a page as the recall shaped it. The page is already
 * bounded in characters, and a byte budget below it would cut it a
 * second time in a different place; this only guards against text
 * that is mostly multi-byte.
 */
const PAGE_BUDGET_BYTES = PAGE_CHARS * 2;

/** What the tool reports beside its text. */
interface RecallDetails {
	readonly kind: Recalled["kind"];
	readonly hits?: number;
}

/** The bounded answer, with anything left out stored and cited. */
function answerOf(recalled: Recalled): string {
	const store = openSessionStore();
	switch (recalled.kind) {
		case "none":
			return recalled.view;
		case "hits":
			return citeListing(store, {
				view: recalled.view,
				records: recalled.hits,
				unit: "matching entries",
				narrowing:
					"Narrow the query, or read one entry by entryId, rather than " +
					"paging through everything.",
				budget: PAGE_BUDGET_BYTES,
				...(recalled.more ? { trailer: recalled.more, elided: true } : {}),
			});
		case "entry":
			return citeListing(store, {
				view: recalled.view,
				records: [recalled.entry],
				unit: "entry, in full",
				narrowing:
					`The entry is longer than a page. Its whole text is the one ` +
					"record's text field.",
				budget: PAGE_BUDGET_BYTES,
				...(recalled.cut ? { elided: true } : {}),
			});
	}
}

export default function sessionRecall(pi: ExtensionAPI) {
	pi.registerTool({
		name: RECALL_TOOL,
		label: "Session Recall",
		description:
			"Search this session's complete log, including what a compaction " +
			"dropped from the context, or read one entry of it by id. A search " +
			"matches any of the query's words, rarer words ranking higher, and " +
			"shows each hit under the entry id that reads it in full.",
		promptSnippet:
			"Search this session's own log, or read an entry by id, to recover what a compaction dropped.",
		promptGuidelines: [
			"After a compaction, when the summary does not hold a detail you need from earlier in the session, search for it with session_recall before re-running tools to rediscover it.",
			"Search with the distinctive words the detail would contain (a file name, an error, an identifier), then read the best hit by entryId.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "Words to search this session's log for.",
				}),
			),
			entryId: Type.Optional(
				Type.String({
					description:
						"Read one entry by id, as a search hit names it, or by a quote's paragraph reference (p: and a hash), as a summary's excerpts name it.",
				}),
			),
			page: Type.Optional(
				Type.Number({
					description:
						"1-based page of hits, when an answer says more entries match.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const recalled = recall(ctx.sessionManager.getBranch(), params);
			return {
				content: [{ type: "text", text: answerOf(recalled) }],
				details: {
					kind: recalled.kind,
					...(recalled.kind === "hits" ? { hits: recalled.hits.length } : {}),
				} satisfies RecallDetails,
			};
		},
	});

	pi.events.on(SUMMARY_CONTRIBUTIONS, (data) => {
		if (!isSummaryContributions(data)) return;
		data.appendix.push(RECALL_NOTE);
	});
}

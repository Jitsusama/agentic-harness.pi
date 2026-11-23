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
 * silently cut. `/compaction-status` says whether the tool is active,
 * how many summaries mention it and how often it has been called.
 *
 * A session rolled over into a fresh log (rollover-workflow), or a
 * hosted conversation holding only its kept history, left its history
 * on disk; recall reads it from there for each call, oldest first, so
 * the session's whole history stays one call away. Each log is read a
 * line at a time, keeping only what the answer shows, so a search of a
 * log of hundreds of megabytes never holds it whole; each read says in
 * the journal how much it read and how long it took, since a large log
 * costs seconds.
 */

import { performance } from "node:perf_hooks";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	isSummaryContributions,
	SUMMARY_CONTRIBUTIONS,
} from "../../lib/compaction/contributions.ts";
import { answerCompactionStatus } from "../../lib/compaction/status.ts";
import { citeListing } from "../../lib/core/result/listing.ts";
import { openSessionStore } from "../../lib/core/result/location.ts";
import {
	answer,
	askedBy,
	markEntries,
	PAGE_CHARS,
	RECALL_TOOL,
	type Recalled,
	type RecallRequest,
} from "../../lib/internal/logs/recall.ts";
import { markedOnDisk } from "../../lib/internal/logs/recall-on-disk.ts";
import { recallSection } from "./status.ts";

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

/**
 * Recall over `branch` and the history it left on disk. The logs on
 * disk are read a line at a time and only what the answer shows is
 * kept, so nothing of them outlives this call; a read of any is said
 * in the journal, its size and time.
 */
function recallWhole(
	sessionId: string,
	branch: readonly unknown[],
	params: RecallRequest,
): Recalled {
	const asked = askedBy(params);
	const started = performance.now();
	const disk = markedOnDisk(branch, asked);
	if (disk.bytes > 0) {
		const ms = Math.round(performance.now() - started);
		const again =
			disk.readAgain > 0 ? `, ${disk.readAgain} read a second time` : "";
		process.stderr.write(
			`session-recall-workflow: conversation ${sessionId} read ${(disk.bytes / MIB).toFixed(1)} MiB from ${disk.logs} log(s) on disk, ${disk.entries} entries${again}, in ${ms} ms\n`,
		);
	}
	// The path comes from the log, so it is quoted: a newline in it
	// can't start a journal line of its own.
	if (disk.unread)
		process.stderr.write(
			`session-recall-workflow: conversation ${sessionId} found no history in ${JSON.stringify(disk.unread.path)} (${disk.unread.reason}), so recall searched no history older than it\n`,
		);
	// The branch is pi's own entries, as the session manager holds them.
	const own = markEntries(branch as Parameters<typeof markEntries>[0], asked);
	return answer([...disk.marked, ...own], params, asked);
}

/** Bytes in a mebibyte, for the journal's read size. */
const MIB = 1024 * 1024;

/** The bounded answer, with anything left out stored and cited. */
function answerOf(recalled: Recalled, ctx: ExtensionContext): string {
	const store = openSessionStore(ctx);
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
					"The entry is longer than a page. Its whole text is the one " +
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
			const recalled = recallWhole(
				ctx.sessionManager.getSessionId(),
				ctx.sessionManager.getBranch(),
				params,
			);
			return {
				content: [{ type: "text", text: answerOf(recalled, ctx) }],
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
	answerCompactionStatus(pi.events, (branch) =>
		recallSection(activeNow(pi), RECALL_NOTE, branch),
	);
}

/** Whether the tool is active, or nothing on a pi that cannot say. */
function activeNow(pi: ExtensionAPI): boolean | undefined {
	if (typeof pi.getActiveTools !== "function") return undefined;
	try {
		return pi.getActiveTools().includes(RECALL_TOOL);
	} catch {
		// Asked outside a session, there is no tool list to read.
		return undefined;
	}
}

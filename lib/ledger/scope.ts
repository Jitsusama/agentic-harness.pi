import type { CallScope } from "@jitsusama/agentic-harness.core/observability";

/**
 * Which tools in the corpus retrieve information, and which ones write
 * the files a later call might read.
 *
 * Repeats and regret only mean something for retrieval: asking a
 * retrieval tool again means the information was needed again, while
 * re-issuing an action (`tdd_loop`, `quest`, `pr_workflow`,
 * `browser_go`) is another action, not a re-fetch. Counting every tool
 * once put one `tdd_loop` call re-issued 79,600 times at the top of
 * regret.
 *
 * Drawn from the tool names actually present in the ledger, not from
 * what is registered today, because the ledger reaches back months.
 * Deliberately left out:
 *
 * - `bash`, the largest tool by far, because it declares no path and a
 *   command cannot be told apart from an action by its digest.
 * - Tools whose answer legitimately changes between two identical
 *   calls: `browser_see`, live metric and log queries, build status.
 *   Asking again there reads a different state, not a lost one.
 *
 * `slack` and `google` are kept although each carries a few write
 * actions under the same name. Their arguments are digested, so a read
 * cannot be split from a write, and an identical write issued twice is
 * rare and waste in its own right.
 *
 * Known understatement of the file-change rule: a `bash` command that
 * modifies a file is not visible as a writer, so a re-read after one
 * still counts. The read figures lean slightly high for it.
 */
export const RETRIEVAL_TOOLS: readonly string[] = [
	"read",
	"grep",
	"ls",
	"web_search",
	"web_read",
	"result_query",
	"tool_gateway_query_result",
	"tool_gateway_describe",
	"tool_gateway_search_tools",
	"review_see",
	"lsp",
	"memory_recall",
	"memory_reflect",
	"vault",
	"slack",
	"google",
	"grokt_search_code",
	"grokt_bulk_search",
	"mastery_lookup_sources",
	"mastery_deep_read",
];

/** Tools that change the file a call declares. */
export const WRITER_TOOLS: readonly string[] = ["edit", "write"];

/** The scope repeats and regret are reported in. */
export const LEDGER_SCOPE: CallScope = {
	retrieval: RETRIEVAL_TOOLS,
	writers: WRITER_TOOLS,
};

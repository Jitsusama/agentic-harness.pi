/**
 * Tool answers that are bounded without being lossy.
 *
 * A tool with a large payload has always had two bad options:
 * spend the caller's context on all of it, or cut it and lose the
 * part that mattered. This library is the third option. The
 * payload goes to a session store under an opaque handle, the
 * answer carries a bounded view and a digest of the shape, and one
 * query language reaches everything that was not shown.
 *
 * The pieces are separate because they are useful separately: a
 * family that already knows how to page its own lists needs only
 * the store and the citation, while one holding a single large
 * document needs the digest too.
 */

export { type Citable, type Cited, cite } from "./cite.ts";
export { count } from "./counts.ts";
export {
	boundedByDetails,
	type DetailRecords,
	recordsIn,
} from "./details.ts";
export { type JsonSummaryOptions, summarizeJson } from "./digest.ts";
export { offerQueryTool, queryTool, withdrawQueryTool } from "./follow.ts";
export {
	citeListing,
	LISTING_BUDGET_BYTES,
	type Listing,
} from "./listing.ts";
export {
	cleanupSessionResults,
	isPidAlive,
	openSessionStore,
	RESULT_ROOT,
	reapAbandonedResults,
	SESSION_QUOTA_BYTES,
	sessionResultDir,
} from "./location.ts";
export {
	DEFAULT_ANSWER_BYTES,
	DEFAULT_MAX_MATCHES,
	type QueryAnswer,
	type QueryOptions,
	queryStored,
	type TextBlock,
} from "./query.ts";
export { type SpilledPayload, spillText } from "./spill.ts";
export {
	createResultStore,
	HandleExpiredError,
	MINTED_HANDLE_SHAPE,
	type ResultStore,
	type StoredResult,
} from "./store.ts";
export { type BudgetedView, withinLineBudget } from "./view.ts";

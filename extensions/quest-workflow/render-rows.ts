/**
 * Plain-text row rendering for the listing-style query
 * verbs. Fully pi-agnostic; the implementation lives in
 * agentic-harness.core.
 */

export {
	collapseListingPreview,
	collapseText,
	isListingDetails,
	type ListingDetails,
	type ListingFlatRow,
	paginate,
	type QuestRowBrief,
	type RowCast,
	type RowDocument,
	type RowJourney,
	renderListing,
	renderListingExpanded,
	renderRowBrief,
} from "../../lib/core/quest/render-rows.ts";

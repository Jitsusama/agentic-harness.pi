/**
 * Plain-text row rendering for the listing-style query
 * verbs. Fully pi-agnostic; the implementation lives in
 * agentic-harness.core.
 */

export {
	collapseListingPreview,
	collapseText,
	DEFAULT_LISTING_LIMIT,
	isListingDetails,
	type ListingDetails,
	type ListingFlatRow,
	type PaginationOpts,
	type PaginationView,
	paginate,
	type QuestRowBrief,
	type QuestRowExpanded,
	questGlyphLegend,
	type RowCast,
	type RowDocument,
	type RowJourney,
	renderListing,
	renderListingExpanded,
	renderRowBrief,
	renderRowExpanded,
	renderRowGlyph,
} from "@jitsusama/agentic-harness.core/quest/render-rows";

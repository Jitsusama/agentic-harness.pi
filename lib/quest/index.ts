/**
 * Public surface of the quest library.
 *
 * Pure data model: ID minting, frontmatter parsing,
 * scaffolding, TOC generation and the pluggable URL-hint
 * fetchers. Plus the pr-workflow bridge registration
 * surface, which is the one cross-extension hook downstream
 * packages need.
 *
 * Discovery, alias indexing, mention indexing and the
 * pr-review-doc round writer live under
 * `lib/internal/quest/` and are not part of this barrel.
 * They are consumed by `extensions/quest-workflow` and
 * `extensions/pr-workflow` (same package) directly. If a
 * downstream package needs them, promote the specific
 * function here intentionally.
 */

export {
	parseDocumentFrontMatter,
	parseQuestFrontMatter,
	serializeDocumentFrontMatter,
	serializeQuestFrontMatter,
	splitFrontMatter,
} from "../internal/quest/frontmatter.js";
export {
	dateOf,
	findIds,
	findIdsWithRelation,
	ID_PREFIXES,
	type IdMention,
	type IdMentionRelation,
	type IdPrefix,
	isId,
	mintId,
	prefixOf,
} from "../internal/quest/id.js";
export {
	checkboxProgress,
	type ExtractedMentions,
	extractCast,
	extractJourney,
	extractMentions,
	extractSection,
	extractSectionParagraph,
	extractTitle,
	milestoneProgress,
	parseQuestDoc,
	projectQuestForShow,
	type QuestShowProjection,
} from "../internal/quest/quest-doc.js";
export {
	type DocumentScaffoldInput,
	defaultsForKind,
	type QuestScaffoldInput,
	scaffoldDocument,
	scaffoldQuestReadme,
} from "../internal/quest/scaffold.js";
export { renderToc } from "../internal/quest/toc.js";
export {
	clearUrlFetchers,
	fetchUrlHints,
	getUrlFetcher,
	listUrlFetchers,
	registerBuiltinUrlFetchers,
	registerUrlFetcher,
	type SeedHints,
	type UrlFetcher,
	unregisterUrlFetcher,
} from "../internal/quest/url-fetchers.js";
export {
	getQuestPrBridge,
	type QuestPrBridge,
	registerQuestPrBridge,
	unregisterQuestPrBridge,
} from "./pr-bridge.js";
export type {
	CastEntry,
	DocumentFrontMatter,
	DocumentKind,
	DocumentStage,
	JourneyEntry,
	PendingPrune,
	QuestAlias,
	QuestDoc,
	QuestDocumentDoc,
	QuestFrontMatter,
	QuestKind,
	QuestPriority,
	QuestSession,
	QuestStatus,
	QuestTree,
	SessionStatus,
} from "./types.js";

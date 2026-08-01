/**
 * Public surface of the quest library.
 *
 * Pure data model: ID minting, frontmatter parsing,
 * scaffolding, TOC generation and the pluggable URL-hint
 * fetchers.
 *
 * This used to claim a pr-workflow bridge registration
 * surface as well, "the one cross-extension hook downstream
 * packages need". No such thing was exported, and the
 * extension it named has been deleted; the round writer it
 * pointed at went with it, having ended up with no reader
 * but its own test. Both sentences are gone rather than
 * reworded, because a barrel comment describing exports
 * that are not there is worse than no comment.
 *
 * Discovery, alias indexing and mention indexing live under
 * `lib/internal/quest/` and are not part of this barrel.
 * They are consumed by `extensions/quest-workflow`
 * directly. If a downstream package needs them, promote the
 * specific function here intentionally.
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

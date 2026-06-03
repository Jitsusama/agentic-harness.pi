/**
 * Public surface of the quest library.
 *
 * Pure data model: ID minting, frontmatter parsing,
 * scaffolding, TOC generation, discovery walk and the
 * reverse-mention index. The quest extension wires these
 * into Pi's lifecycle; downstream packages can use them to
 * read quest state without loading the extension.
 *
 * Storage and runtime state (loaded quest, focused
 * document, status bar) live in the extension. This library
 * is reusable for tooling, scripts and migrations.
 */

export {
	type AliasIndex,
	aliasKey,
	buildAliasIndex,
	lookupAlias,
} from "../internal/quest/alias-index.js";
export { appendJourneyByPath } from "../internal/quest/append-journey.js";
export {
	type DiscoveryResult,
	discoverQuests,
	type QuestDocumentEntry,
	type QuestEntry,
	type QuestIndex,
} from "../internal/quest/discovery.js";
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
	ID_PREFIXES,
	type IdPrefix,
	isId,
	mintId,
	prefixOf,
} from "../internal/quest/id.js";
export {
	buildMentionIndex,
	type MentionEdge,
	type MentionIndex,
	mentionsOf,
} from "../internal/quest/mentions.js";
export {
	type AppendRoundInput,
	type AppendRoundResult,
	appendPrReviewRound,
	type RenderRoundInput,
	type ReviewDocAgreement,
	type ReviewDocCritique,
	type ReviewDocCritiquePosition,
	type ReviewDocFinding,
	type ReviewDocJudgeSelfSignal,
	renderPrReviewRound,
} from "../internal/quest/pr-review-doc.js";
export {
	type FindOrCreateInput,
	type FindOrCreateResult,
	findOrCreateSidequestForPr,
	type PrSidequestRef,
} from "../internal/quest/pr-sidequest.js";
export {
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
	after as rankAfter,
	before as rankBefore,
	bottom as rankBottom,
	bump as rankBump,
	diffRanks,
	type RankEntry,
	renumber as rankRenumber,
	sink as rankSink,
	sortByRank,
	top as rankTop,
} from "../internal/quest/ranking.js";
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
	QuestAlias,
	QuestDoc,
	QuestDocumentDoc,
	QuestFrontMatter,
	QuestKind,
	QuestPriority,
	QuestSession,
	QuestStatus,
	SessionStatus,
} from "./types.js";

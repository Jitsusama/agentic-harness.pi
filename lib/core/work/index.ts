/**
 * The working layer: branches, commits, trees and stacks.
 *
 * Reviewing a change and working on one are different jobs, and
 * this is the second. It is deliberately not called `git`: git is
 * one implementation of it, and on a stacked workflow the backend
 * that tracks the stack knows things plain git cannot be asked.
 *
 * Only the trees question is answered so far: where a tree gets
 * cut from, and whether one already on disk answers a fresh
 * request. Both are here before the council moves across, because
 * the council cannot become provider-agnostic while it is asking a
 * forge-shaped question.
 */

export type { Renumbered, SettledFile, StaleCitation } from "./appends.ts";
export type {
	AskedRepo,
	TreeAsk,
	TreeRequestOutcome,
} from "./ask.ts";
export { treeRequestFrom } from "./ask.ts";
export type {
	BranchOptions,
	CommitMessage,
	WorkAuthor,
} from "./author.ts";
export {
	createGitAuthor,
	namingComplaints,
	safeBranchName,
} from "./author.ts";
export type {
	HeldTree,
	TreeBroker,
	TreeCallOptions,
	TreeProvider,
} from "./broker.ts";
export { createTreeBroker } from "./broker.ts";
export type { TreeClaims, WorkApi } from "./events.ts";
export {
	WORK_READY,
	WORK_REGISTER_TREE_PROVIDER,
	WORK_REQUEST,
	WORK_TREE_CLAIMS,
} from "./events.ts";
export type {
	ChangedPath,
	TreeHead,
	WorkHistory,
	WorkingState,
} from "./history.ts";
export { blocksRepoint, createGitHistory } from "./history.ts";
export type { TreeAmbiguous, TreeInPlay } from "./inplay.ts";
export { chooseTree, treeInPlay } from "./inplay.ts";
export { createTreeMemory, type TreeMemory } from "./memory.ts";
export type {
	Objection,
	PublishIntent,
	PublishReview,
} from "./objection.ts";
export {
	cautionsFrom,
	refusalFrom,
	WORK_PUBLISH_CHECK,
} from "./objection.ts";
export type { TreeProviderChoice, TreeProviderInfo } from "./provider.ts";
export { chooseTreeProvider } from "./provider.ts";
export { createGitTreeProvider } from "./providers/git.ts";
export type { PushOptions, PushOutcome, WorkPublisher } from "./publish.ts";
export { createGitPublisher } from "./publish.ts";
export type {
	RebaseOutcome,
	ResumeOutcome,
	Settling,
	WorkRebaser,
} from "./rebase.ts";
export { createGitRebaser } from "./rebase.ts";
export type {
	ReclaimDeps,
	ReclaimedTree,
	ReclaimOutcome,
} from "./reclaim.ts";
export { reclaimTrees } from "./reclaim.ts";
export {
	clearTreeProviders,
	listTreeProviders,
	registerTreeProvider,
	unregisterTreeProvider,
} from "./register.ts";
export type {
	Faulted,
	ReorderPlan,
	ReparentStep,
	ReplayStep,
	RestackPlan,
	StackedBranch,
	StackFault,
	StackOrder,
} from "./stack.ts";
export {
	descendantsOf,
	orderStack,
	planReorder,
	planRestack,
	reparentFault,
} from "./stack.ts";
export type {
	ReplayResult,
	RestackOutcome,
	ShapeOutcome,
	SyncOutcome,
	WorkStacks,
} from "./stacks.ts";
export { createGitStacks } from "./stacks.ts";
export type { SurveyRequest, SurveyTarget } from "./survey.ts";
export { heldNames, surveyTarget } from "./survey.ts";
export type {
	Kept,
	LocalBranch,
	OrphanAsk,
	OrphanPlan,
	Reclaimable,
	Removable,
	Retained,
	TidyAsk,
	TidyPlan,
	WorktreeOnDisk,
} from "./tidy.ts";
export { orphanedTrees, tidyPlan } from "./tidy.ts";
export type { TreeIdentity, TreeRequest, TreeSource } from "./tree.ts";
export { satisfies, treeIdentity, treeSource } from "./tree.ts";

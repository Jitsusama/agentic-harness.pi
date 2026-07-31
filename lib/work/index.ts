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

export type {
	AskedRepo,
	TreeAsk,
	TreeRequestOutcome,
} from "./ask.js";
export { treeRequestFrom } from "./ask.js";
export type {
	BranchOptions,
	CommitMessage,
	WorkAuthor,
} from "./author.js";
export { createGitAuthor, safeBranchName } from "./author.js";
export type { HeldTree, TreeBroker, TreeProvider } from "./broker.js";
export { createTreeBroker } from "./broker.js";
export type { WorkApi } from "./events.js";
export {
	WORK_READY,
	WORK_REGISTER_TREE_PROVIDER,
	WORK_REQUEST,
} from "./events.js";
export type {
	ChangedPath,
	TreeHead,
	WorkHistory,
	WorkingState,
} from "./history.js";
export { blocksRepoint, createGitHistory } from "./history.js";
export { createTreeMemory, type TreeMemory } from "./memory.js";
export type {
	Objection,
	PublishIntent,
	PublishReview,
} from "./objection.js";
export {
	cautionsFrom,
	refusalFrom,
	WORK_PUBLISH_CHECK,
} from "./objection.js";
export type { TreeProviderChoice, TreeProviderInfo } from "./provider.js";
export { chooseTreeProvider } from "./provider.js";
export { createGitTreeProvider } from "./providers/git.js";
export type { PushOptions, PushOutcome, WorkPublisher } from "./publish.js";
export { createGitPublisher } from "./publish.js";
export type {
	RebaseOutcome,
	ResumeOutcome,
	WorkRebaser,
} from "./rebase.js";
export { createGitRebaser } from "./rebase.js";
export {
	clearTreeProviders,
	listTreeProviders,
	registerTreeProvider,
	unregisterTreeProvider,
} from "./register.js";
export type {
	Faulted,
	ReorderPlan,
	ReparentStep,
	ReplayStep,
	RestackPlan,
	StackedBranch,
	StackFault,
	StackOrder,
} from "./stack.js";
export {
	descendantsOf,
	orderStack,
	planReorder,
	planRestack,
	reparentFault,
} from "./stack.js";
export type {
	ReplayResult,
	RestackOutcome,
	ShapeOutcome,
	SyncOutcome,
	WorkStacks,
} from "./stacks.js";
export { createGitStacks } from "./stacks.js";
export type { TreeIdentity, TreeRequest, TreeSource } from "./tree.js";
export { satisfies, treeIdentity, treeSource } from "./tree.js";

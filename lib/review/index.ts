/**
 * Public surface of the review library.
 *
 * One substrate for the activity of reviewing code changes,
 * whatever hosts them and whether anything hosts them at
 * all. A change, its stack, its reviews, its threads and its
 * messages are one neutral model; GitHub, Meteorite, GitLab
 * and a bare git repo are providers behind it.
 *
 * The vocabulary is git's wherever git has a word for the
 * thing: a diff has an old and a new side rather than a left
 * and a right, an anchor names the commit it was formed
 * against, and a stack is refs pointing at refs. Forge
 * inventions stay inside their providers.
 */

export type {
	Anchor,
	AnchorCheck,
	AnchorRefusal,
	DiffSide,
	FileAnchor,
	LineAnchor,
} from "./anchor.js";
export { anchorable } from "./anchor.js";
export type { TargetResolution } from "./bind.js";
export {
	bindTarget,
	clearTargetBindings,
	resolveTarget,
} from "./bind.js";
export type {
	Capabilities,
	ConversationCapabilities,
	ProposalCapabilities,
	StackingCapabilities,
	StalenessModel,
} from "./capabilities.js";
export type {
	Actor,
	ChangeRef,
	ChangeState,
	Proposal,
	RepoLocator,
	ReviewTarget,
} from "./change.js";
export type { Check, CheckState, ChecksRollup } from "./checks.js";
export type {
	ReferenceMapping,
	RepoMapping,
	ReviewConfig,
} from "./config.js";
export type {
	AnchoredComment,
	Message,
	Posted,
	Reaction,
	ReactionCount,
	Review,
	Thread,
	Verdict,
	WireReview,
} from "./conversation.js";
export type {
	DiffFile,
	DiffHunk,
	DiffLine,
	DiffModel,
	DiffStatus,
} from "./diff.js";
export { parseUnifiedDiff } from "./diff.js";
export type { DraftDeps, ReviewDraft } from "./draft/handle.js";
export { openDraft, resumeDraft } from "./draft/handle.js";
export type {
	Degradation,
	PlanContext,
	PlannedOp,
	PlanRefusal,
	PublishPlan,
} from "./draft/plan.js";
export { compilePlan } from "./draft/plan.js";
export type { OpOutcome, PublishOutcome } from "./draft/publish.js";
export { publishPlan } from "./draft/publish.js";
export type { RenderOptions, ReviewDocument } from "./draft/render.js";
export { renderDraft } from "./draft/render.js";
export type {
	DraftItem,
	DraftState,
	FindingItem,
	ReactionItem,
	ReplyItem,
	ResolutionItem,
} from "./draft/state.js";
export {
	addFinding,
	addReaction,
	addReply,
	addResolution,
	emptyDraft,
	removeItem,
	setVerdict,
} from "./draft/state.js";
export type { DraftStore, DraftSummary } from "./draft/store.js";
export { createDraftStore } from "./draft/store.js";
export type { ReviewSubstrateApi } from "./events.js";
export { REVIEW_READY, REVIEW_REGISTER_PROVIDER } from "./events.js";
export { changeKey, repoKey, targetKey } from "./keys.js";
export type {
	AuthoringFacet,
	ChangeFilter,
	ConversationFacet,
	FieldEdit,
	LocalBranch,
	MergeRequest,
	ProposalDraft,
	ProposalEdit,
	ProposalsFacet,
	RepoProbe,
	ReviewProvider,
	StackingFacet,
} from "./provider.js";
export {
	clearReviewProviders,
	getReviewProvider,
	listReviewProviders,
	registerReviewProvider,
	unregisterReviewProvider,
} from "./register.js";
export type {
	Resolution,
	ResolutionRefusal,
	ResolveContext,
	ResolvedVia,
} from "./resolve.js";
export { resolveReference } from "./resolve.js";
export type { Stack, StackNode, StackProvenance } from "./stack.js";

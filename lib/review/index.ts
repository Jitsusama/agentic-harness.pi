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

// Re-exported, not owned. These live in `lib/exec` now, because the working layer
// needed the same subprocess shape and reaching into this library's provider folder
// for it said the two domains were related when only the seam is. Kept here because
// downstream packages import them from this barrel, and moving a file is not a
// reason to break them.
//
// `run` goes out beside `Exec` for the same reason it always did: a consumer handed
// an `Exec` needs a runner that keeps the CLI's own words on failure, and writing
// that again per library produces worse diagnostics.
export type { Exec, ExecResult, ProviderDeps } from "../exec/index.js";
export { run } from "../exec/index.js";
export type {
	Anchor,
	AnchorCheck,
	AnchorRefusal,
	ChangeAnchor,
	FileAnchor,
	LineAnchor,
} from "./anchor.js";
export { anchorable, anchorPath, describeAnchor } from "./anchor.js";
export type { FileRanges, LineRange } from "./ask/anchorable.js";
export { anchorableRanges, describeRanges } from "./ask/anchorable.js";
export type { AnswerContext, AnswerLine } from "./ask/answer.js";
export { describeRun, roundAnswer } from "./ask/answer.js";
export type {
	AuditHarvest,
	AuditRequest,
	AuditResult,
	Standing,
	ThreadAudit,
} from "./ask/audit.js";
export { harvestAudits, runAudit } from "./ask/audit.js";
export { type CollectDeps, collectRound } from "./ask/collect.js";
export type {
	Ask,
	AskAnswer,
	AskContext,
	AskLimit,
	AskStop,
	CouncilDeps,
	CouncilRequest,
	CouncilResult,
} from "./ask/council.js";
export { runCouncil } from "./ask/council.js";
export type {
	Critique,
	CritiqueDeps,
	CritiqueHarvest,
	CritiqueRequest,
	CritiqueResult,
	Position,
} from "./ask/critique.js";
export { harvestCritiques, runCritique } from "./ask/critique.js";
export type { Harvest } from "./ask/harvest.js";
export { alsoRecorded, harvestFindings } from "./ask/harvest.js";
// Asking other models about a change: who is asked, and keeping
// what their names mean stable while findings accumulate.
export type {
	ClaimOutcome,
	IdentityLedger,
	Participant,
	ParticipantIdentity,
	ParticipantRole,
} from "./ask/identity.js";
export {
	attributedTo,
	createIdentityLedger,
	participantIdentity,
} from "./ask/identity.js";
export type { JudgeRequest, JudgeResult } from "./ask/judge.js";
export { runJudge } from "./ask/judge.js";
export type {
	CharterLookup,
	Persona,
	PersonaBind,
	PersonaBinding,
	PersonaParse,
} from "./ask/persona.js";
export { bindPersonas, parsePersona } from "./ask/persona.js";
export {
	type AskProgress,
	type AskProgressEntry,
	type AskProgressState,
	noAskProgress,
	trackAskProgress,
} from "./ask/progress.js";
export type {
	AuditPromptInput,
	CritiquePromptInput,
	JudgePromptInput,
	PromptInput,
	StackChangePrompt,
	StackPromptInput,
} from "./ask/prompt.js";
export {
	auditPrompt,
	councilPrompt,
	critiquePrompt,
	judgePrompt,
	stackPrompt,
} from "./ask/prompt.js";
export type { ParticipantParse, Roster, RosterParse } from "./ask/roster.js";
export { parseParticipant, parseRoster } from "./ask/roster.js";
export type {
	AskRound,
	AskRun,
	AskUsage,
	ParticipantOutcome,
	RunSummary,
} from "./ask/run.js";
export {
	askedOf,
	failureLines,
	newRunId,
	runSummary,
	staleRuntimeAdvisory,
	stoppedNotes,
	substituteOutcome,
} from "./ask/run.js";
export type {
	FindingSpan,
	SpannedFinding,
	StackHarvest,
} from "./ask/span.js";
export { harvestStackFindings, saidAt } from "./ask/span.js";
export type {
	StackCouncilDeps,
	StackCouncilRequest,
} from "./ask/stack-round.js";
export { runStackCouncil } from "./ask/stack-round.js";
export { type StartDeps, startCouncil } from "./ask/start.js";
export type { RunStore } from "./ask/store.js";
export { createRunStore } from "./ask/store.js";
export type {
	Attachment,
	AttachmentStore,
	ChangeAmbiguous,
	ChangeInPlay,
} from "./attach.js";
export {
	changeInPlay,
	chooseChange,
	createAttachmentStore,
	inheritAttachments,
	pruneAttachments,
} from "./attach.js";
export type { AuthoringIntent, Offerable } from "./authoring.js";
export { misnamedPeople, offerable } from "./authoring.js";
export type { Unbacked } from "./backed.js";
export { BACKED_BY, unbackedDeclarations } from "./backed.js";
export type { RepoResolution, TargetResolution } from "./bind.js";
export {
	bindTarget,
	clearTargetBindings,
	resolveRepo,
	resolveTarget,
} from "./bind.js";
export type {
	AuthoringCapabilities,
	Capabilities,
	ConversationCapabilities,
	PersonForm,
	ProposalCapabilities,
	RetargetScope,
	ReviewersAt,
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
export type {
	Check,
	CheckState,
	ChecksRollup,
	RerunOutcome,
} from "./checks.js";
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
export type { Decision, DecisionLedger, Settlement } from "./decided.js";
export { createDecisionLedger } from "./decided.js";
export type {
	DiffFile,
	DiffHunk,
	DiffLine,
	DiffModel,
	DiffSide,
	DiffStatus,
} from "./diff.js";
export {
	changeCounts,
	displayPath,
	filePath,
	hunkHeader,
	lineNumberOn,
	parseUnifiedDiff,
} from "./diff.js";
export type {
	ChangePublishOutcome,
	StackPublishEntry,
	StackPublishOutcome,
} from "./draft/fanout.js";
export { publishAcross } from "./draft/fanout.js";
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
	UnresolutionItem,
} from "./draft/state.js";
export {
	addFinding,
	addReaction,
	addReply,
	addResolution,
	addUnresolution,
	emptyDraft,
	removeItem,
	setVerdict,
} from "./draft/state.js";
export type { DraftStore, DraftSummary } from "./draft/store.js";
export { createDraftStore } from "./draft/store.js";
export { repoElsewhere } from "./elsewhere.js";
export type {
	BoundTarget,
	LocalSpec,
	ReviewEngine,
	ReviewEngineDeps,
	ServingRepo,
} from "./engine.js";
export { createReviewEngine } from "./engine.js";
export type { ReviewSubstrateApi } from "./events.js";
export {
	REVIEW_READY,
	REVIEW_REGISTER_PROVIDER,
	REVIEW_REQUEST_SUBSTRATE,
} from "./events.js";
export type { FailureContext } from "./failed.js";
export { explainFailure, readsAsMissing } from "./failed.js";
export type {
	ConventionalLabel,
	Finding,
	FindingOrigin,
	FindingSeverity,
	FindingStore,
} from "./finding.js";
export { createFindingStore } from "./finding.js";
export type {
	FixOutcome,
	FixQueue,
	FixSubject,
	FixTally,
	QueuedFix,
	QueuedThread,
} from "./fix.js";
export { createFixQueue, describeSubject, subjectOf } from "./fix.js";
export type { FollowUp, Reception } from "./followup.js";
export {
	followUpOn,
	receptionOf,
	tallyReceptions,
} from "./followup.js";
export { changeKey, repoKey, targetKey } from "./keys.js";
export type { Landability } from "./landing.js";
export { standsAt } from "./landing.js";
export type {
	CheckoutFacts,
	ProposalFill,
	ProposalWanted,
} from "./propose-from.js";
export { fillProposal } from "./propose-from.js";
export type {
	AuthoringFacet,
	ChangeFilter,
	ConversationFacet,
	FieldEdit,
	LocalBranch,
	MergeOutcome,
	MergeRequest,
	ProposalDraft,
	ProposalEdit,
	ProposalsFacet,
	RepoProbe,
	ReviewProvider,
	SetEdit,
	StackingFacet,
} from "./provider.js";
export { createGitProvider } from "./providers/git/index.js";
export { githubAuthoring } from "./providers/github/authoring.js";
/**
 * The GitHub provider's pure helpers, for consumers still
 * bridging GitHub-shaped code onto the substrate. Neither
 * touches the network, and both are safe to call before any
 * provider is registered.
 */
export {
	claimGitHubReference,
	GITHUB_PROVIDER_ID,
	githubChange,
	ownerRepoFromKey,
} from "./providers/github/claims.js";
export { createGitHubProvider } from "./providers/github/index.js";
export type { QueuePosture, QueueRefusal, QueueState } from "./queue.js";
export { queueRefusal } from "./queue.js";
export type {
	Reactable,
	ReactableKind,
	ReactableRefusal,
} from "./reactable.js";
export {
	findReactable,
	isReactableRefusal,
	reactableAddresses,
	reactableLabel,
	reactables,
} from "./reactable.js";
export type { ProviderComplaint } from "./register.js";
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
export type { Retarget, RetargetPlan, RetargetRoute } from "./retarget.js";
export { retargetPlan, retargetRoute } from "./retarget.js";
export type { SinceLastVisit, Visit, VisitLog } from "./revisited.js";
export {
	createVisitLog,
	describeVisit,
	sinceLastVisit,
} from "./revisited.js";
export type {
	Stack,
	StackNode,
	StackProvenance,
	StackStep,
} from "./stack.js";
export { stackStep } from "./stack.js";

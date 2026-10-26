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
export type { Exec, ExecResult, ProviderDeps } from "../exec/index.ts";
export { run } from "../exec/index.ts";
export type {
	Anchor,
	AnchorCheck,
	AnchorRefusal,
	ChangeAnchor,
	FileAnchor,
	LineAnchor,
} from "./anchor.ts";
export { anchorable, anchorPath, describeAnchor } from "./anchor.ts";
export type {
	AgentDiscovery,
	AgentFile,
	RepoAgent,
} from "./ask/agents.ts";
export { discoverAgents, NAMESPACE } from "./ask/agents.ts";
export type { FileRanges, LineRange } from "./ask/anchorable.ts";
export { anchorableRanges, describeRanges } from "./ask/anchorable.ts";
export type { AnswerContext, AnswerLine } from "./ask/answer.ts";
export { describeRun, roundAnswer } from "./ask/answer.ts";
export type {
	AuditHarvest,
	AuditRequest,
	AuditResult,
	Standing,
	ThreadAudit,
} from "./ask/audit.ts";
export { harvestAudits, runAudit } from "./ask/audit.ts";
export { type CollectDeps, collectRound } from "./ask/collect.ts";
export type {
	Ask,
	AskAnswer,
	AskContext,
	AskLimit,
	AskStop,
	CouncilDeps,
	CouncilRequest,
	CouncilResult,
} from "./ask/council.ts";
export { runCouncil } from "./ask/council.ts";
export type {
	Critique,
	CritiqueDeps,
	CritiqueHarvest,
	CritiqueRequest,
	CritiqueResult,
	Position,
} from "./ask/critique.ts";
export { harvestCritiques, runCritique } from "./ask/critique.ts";
export type { Harvest } from "./ask/harvest.ts";
export { alsoRecorded, harvestFindings } from "./ask/harvest.ts";
// Asking other models about a change: who is asked, and keeping
// what their names mean stable while findings accumulate.
export type {
	ClaimOutcome,
	IdentityLedger,
	Participant,
	ParticipantIdentity,
	ParticipantRole,
} from "./ask/identity.ts";
export {
	attributedTo,
	createIdentityLedger,
	participantIdentity,
} from "./ask/identity.ts";
export type { JudgeRequest, JudgeResult } from "./ask/judge.ts";
export { runJudge } from "./ask/judge.ts";
export type {
	CharterLookup,
	Persona,
	PersonaBind,
	PersonaBinding,
	PersonaParse,
} from "./ask/persona.ts";
export { bindPersonas, parsePersona } from "./ask/persona.ts";
export {
	type AskProgress,
	type AskProgressEntry,
	type AskProgressState,
	noAskProgress,
	trackAskProgress,
} from "./ask/progress.ts";
export type {
	AuditPromptInput,
	CritiquePromptInput,
	GuidanceState,
	JudgePromptInput,
	PromptInput,
	RepoGuidance,
	StackChangePrompt,
	StackPromptInput,
} from "./ask/prompt.ts";
export {
	auditPrompt,
	councilPrompt,
	critiquePrompt,
	judgePrompt,
	quotable,
	stackPrompt,
} from "./ask/prompt.ts";
export type { ParticipantParse, Roster, RosterParse } from "./ask/roster.ts";
export {
	overrideRoster,
	type ParticipantOverride,
	parseParticipant,
	parseRoster,
} from "./ask/roster.ts";
export type {
	AskRound,
	AskRun,
	AskUsage,
	ParticipantOutcome,
	RoundGiven,
	RunSummary,
	TreeRead,
} from "./ask/run.ts";
export {
	askedOf,
	failureLines,
	newRunId,
	retryCannotResettle,
	runSummary,
	staleRuntimeAdvisory,
	stoppedNotes,
	substituteOutcome,
	whatItRead,
} from "./ask/run.ts";
export type {
	FindingSpan,
	SpannedFinding,
	StackHarvest,
} from "./ask/span.ts";
export { harvestStackFindings, saidAt } from "./ask/span.ts";
export type {
	StackCouncilDeps,
	StackCouncilRequest,
} from "./ask/stack-round.ts";
export { runStackCouncil } from "./ask/stack-round.ts";
export {
	type StartDeps,
	type StartResult,
	startCouncil,
} from "./ask/start.ts";
export type { OpenRuns, RunStore } from "./ask/store.ts";
export { createRunStore } from "./ask/store.ts";
export type {
	Attachment,
	AttachmentStore,
	ChangeAmbiguous,
	ChangeInPlay,
} from "./attach.ts";
export {
	changeInPlay,
	chooseChange,
	createAttachmentStore,
	inheritAttachments,
	pruneAttachments,
} from "./attach.ts";
export type { AuthoringIntent, Offerable } from "./authoring.ts";
export { misnamedPeople, offerable } from "./authoring.ts";
export type { Unbacked } from "./backed.ts";
export { BACKED_BY, unbackedDeclarations } from "./backed.ts";
export type { RepoResolution, TargetResolution } from "./bind.ts";
export {
	bindTarget,
	clearTargetBindings,
	resolveRepo,
	resolveTarget,
} from "./bind.ts";
export type { ReviewerBudget, ReviewerClocks } from "./budget.ts";
export {
	boundsFor,
	budgetForLimit,
	REVIEWER_ANSWER_MS,
	REVIEWER_BACKSTOP_MS,
	REVIEWER_IDLE_MS,
	retryWouldRepeat,
	reviewerBudget,
} from "./budget.ts";
export type {
	AuthoringCapabilities,
	Capabilities,
	ChangeCapabilities,
	ConversationCapabilities,
	PersonForm,
	RetargetScope,
	ReviewersAt,
	StackingCapabilities,
	StalenessModel,
} from "./capabilities.ts";
export type {
	Actor,
	Change,
	ChangeRef,
	ChangeState,
	RepoLocator,
	ReviewTarget,
} from "./change.ts";
export type {
	Check,
	CheckState,
	ChecksRollup,
	RerunOutcome,
} from "./checks.ts";
export type {
	LoadedReviewConfig,
	ReferenceMapping,
	RepoMapping,
	ReviewConfig,
} from "./config.ts";
export { parseReviewSection } from "./config.ts";
export { proposalComplaint } from "./conventions.ts";
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
} from "./conversation.ts";
export type { Decision, DecisionLedger, Settlement } from "./decided.ts";
export { createDecisionLedger } from "./decided.ts";
export type {
	DiffFile,
	DiffHunk,
	DiffLine,
	DiffModel,
	DiffSide,
	DiffStatus,
} from "./diff.ts";
export {
	changeCounts,
	displayPath,
	filePath,
	hunkHeader,
	lineNumberOn,
	parseUnifiedDiff,
} from "./diff.ts";
export type {
	ChangePublishOutcome,
	StackPublishEntry,
	StackPublishOutcome,
} from "./draft/fanout.ts";
export { publishAcross } from "./draft/fanout.ts";
export type { DraftDeps, ReviewDraft } from "./draft/handle.ts";
export { openDraft, resumeDraft } from "./draft/handle.ts";
export type {
	Degradation,
	PlanContext,
	PlannedOp,
	PlanRefusal,
	PublishPlan,
} from "./draft/plan.ts";
export { compilePlan } from "./draft/plan.ts";
export type {
	OpOutcome,
	PublishOptions,
	PublishOutcome,
} from "./draft/publish.ts";
export { publishPlan, STOPPED_BEFORE_SENT } from "./draft/publish.ts";
export type { RenderOptions, ReviewDocument } from "./draft/render.ts";
export { renderDraft } from "./draft/render.ts";
export type {
	DraftItem,
	DraftState,
	FindingItem,
	ReactionItem,
	ReplyItem,
	ResolutionItem,
	UnresolutionItem,
} from "./draft/state.ts";
export {
	addFinding,
	addReaction,
	addReply,
	addResolution,
	addUnresolution,
	emptyDraft,
	removeItem,
	setVerdict,
} from "./draft/state.ts";
export type { DraftStore, DraftSummary } from "./draft/store.ts";
export { createDraftStore } from "./draft/store.ts";
export { repoElsewhere } from "./elsewhere.ts";
export type {
	BoundTarget,
	LocalSpec,
	ReviewEngine,
	ReviewEngineDeps,
	ServingRepo,
} from "./engine.ts";
export { createReviewEngine } from "./engine.ts";
export type { ReviewSubstrateApi } from "./events.ts";
export {
	REVIEW_READY,
	REVIEW_REGISTER_PROVIDER,
	REVIEW_REQUEST_SUBSTRATE,
} from "./events.ts";
export type { FailureContext } from "./failed.ts";
export { explainFailure, readsAsMissing } from "./failed.ts";
export type {
	ConventionalLabel,
	Finding,
	FindingOrigin,
	FindingSeverity,
	FindingStore,
} from "./finding.ts";
export { createFindingStore } from "./finding.ts";
export type {
	FixOutcome,
	FixQueue,
	FixSubject,
	FixTally,
	QueuedFix,
	QueuedThread,
} from "./fix.ts";
export { createFixQueue, describeSubject, subjectOf } from "./fix.ts";
export type { FollowUp, Reception } from "./followup.ts";
export {
	followUpOn,
	receptionOf,
	tallyReceptions,
} from "./followup.ts";
export { changeKey, repoKey, targetKey } from "./keys.ts";
export type { Landability } from "./landing.ts";
export { standsAt } from "./landing.ts";
export type { ReadableTree, Touched } from "./lenses.ts";
export {
	agentsInRepo,
	chartersOnDisk,
	givenBy,
	guidanceFor,
	guidanceInRepo,
	lensesFor,
	touchedBy,
} from "./lenses.ts";
export type {
	CheckoutFacts,
	ProposalFill,
	ProposalWanted,
} from "./propose-from.ts";
export { fillProposal } from "./propose-from.ts";
export type {
	AuthoringFacet,
	ChangeDraft,
	ChangeEdit,
	ChangeFilter,
	ChangesFacet,
	ConversationFacet,
	FieldEdit,
	LocalBranch,
	MergeOutcome,
	MergeRequest,
	RepoProbe,
	ReviewProvider,
	SetEdit,
	StackingFacet,
} from "./provider.ts";
export { createGitProvider } from "./providers/git/index.ts";
export { githubAuthoring } from "./providers/github/authoring.ts";
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
} from "./providers/github/claims.ts";
export { createGitHubProvider } from "./providers/github/index.ts";
export type { QueuePosture, QueueRefusal, QueueState } from "./queue.ts";
export { queueRefusal } from "./queue.ts";
export type {
	Reactable,
	ReactableKind,
	ReactableRefusal,
} from "./reactable.ts";
export {
	findReactable,
	isReactableRefusal,
	reactableAddresses,
	reactableLabel,
	reactables,
} from "./reactable.ts";
export type { ProviderComplaint } from "./register.ts";
export {
	clearReviewProviders,
	getReviewProvider,
	listReviewProviders,
	registerReviewProvider,
	unregisterReviewProvider,
} from "./register.ts";
export type {
	Resolution,
	ResolutionRefusal,
	ResolveContext,
	ResolvedVia,
} from "./resolve.ts";
export { checkoutFor, resolveReference } from "./resolve.ts";
export type { Retarget, RetargetPlan, RetargetRoute } from "./retarget.ts";
export { retargetPlan, retargetRoute } from "./retarget.ts";
export type { SinceLastVisit, Visit, VisitLog } from "./revisited.ts";
export {
	createVisitLog,
	describeVisit,
	sinceLastVisit,
} from "./revisited.ts";
export type {
	Stack,
	StackNode,
	StackProvenance,
	StackStep,
} from "./stack.ts";
export { stackStep } from "./stack.ts";

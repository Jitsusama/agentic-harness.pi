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
	ChangeAnchor,
	FileAnchor,
	LineAnchor,
} from "./anchor.js";
export { anchorable, anchorPath, describeAnchor } from "./anchor.js";
export type { FileRanges, LineRange } from "./ask/anchorable.js";
export { anchorableRanges, describeRanges } from "./ask/anchorable.js";
export type {
	AuditHarvest,
	AuditRequest,
	AuditResult,
	Standing,
	ThreadAudit,
} from "./ask/audit.js";
export { harvestAudits, runAudit } from "./ask/audit.js";
export type {
	AskAnswer,
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
export { harvestFindings } from "./ask/harvest.js";
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
	newRunId,
	runSummary,
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
} from "./attach.js";
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
export type {
	BoundTarget,
	LocalSpec,
	ReviewEngine,
	ReviewEngineDeps,
} from "./engine.js";
export { createReviewEngine } from "./engine.js";
export type { ReviewSubstrateApi } from "./events.js";
export {
	REVIEW_READY,
	REVIEW_REGISTER_PROVIDER,
	REVIEW_REQUEST_SUBSTRATE,
} from "./events.js";
export type {
	ConventionalLabel,
	Finding,
	FindingOrigin,
	FindingSeverity,
	FindingStore,
} from "./finding.js";
export { createFindingStore } from "./finding.js";
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
export type { Exec, ExecResult, ProviderDeps } from "./providers/exec.js";
// `run` goes out with the seam it belongs to. A consumer handed an
// `Exec` needs a runner that keeps the CLI's own words on failure,
// and writing that again per library produces worse diagnostics.
export { run } from "./providers/exec.js";
export { createGitProvider } from "./providers/git/index.js";
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
export type {
	Stack,
	StackNode,
	StackProvenance,
	StackStep,
} from "./stack.js";
export { stackStep } from "./stack.js";

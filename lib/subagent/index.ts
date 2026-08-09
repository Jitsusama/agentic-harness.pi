/**
 * Subagent engine: run pi as a child process for fanned-out
 * investigation, brainstorming or persona-driven review.
 *
 * Each subagent gets its own pi process, its own context
 * window, its own working directory and its own tool
 * palette. Callers compose a {@link SubagentSpec} (who is
 * this subagent) with a {@link SubagentJob} (what it should
 * do) and hand the pair to {@link runSubagent} or fan many
 * out via {@link runFleet}.
 *
 * Two runner implementations live under `./runpi`:
 *
 * - `createSpawnRunPi`: fire-and-forget; the child dies
 *   with the parent. Cheapest path; suitable for council
 *   fan-outs inside an interactive session.
 * - `createSupervisorRunPi`: durable; each run lives
 *   under a state directory so subsequent sessions can
 *   recover in-flight work via {@link recoverReviewerRuns}.
 *
 * The verify protocol is the engine's one structured
 * contract with the subagent: when a job carries a
 * {@link VerifyPack}, the engine injects the verify
 * extension (and its companion skill, when present), then
 * rejects the run unless `verify_output` was called and
 * returned `ok: true`. Schemas live in the consumer's
 * pack; the engine never inspects them.
 */

// What a subagent is doing right now, for a caller that is waiting.
export { summarizeStreamActivity } from "./activity.js";
// How a run ended is part of what a run result says, so a consumer
// reading the result needs the vocabulary to read the field.
export type { ReviewerTerminalState } from "./artifacts.js";
// Durable artifacts and recovery (supervisor path).
export { ReviewerArtifactsStore } from "./artifacts.js";
// Engine-wide always-load defaults.
export {
	clearSubagentDefaults,
	getSubagentDefaults,
	registerSubagentDefaultExtension,
	registerSubagentDefaultSkill,
} from "./defaults.js";
// The bus names the domain answers to, so a consumer registering a
// default needs this library and never the extension that hosts it.
export {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
	SUBAGENT_REGISTER_DEFAULT_SKILL,
} from "./events.js";
export type {
	FleetLedger,
	FleetRun,
	HeldFleets,
	OpenFleets,
} from "./fleet.js";
// What a fleet is on disk, so a consumer can say which runs the
// sweep may not take and find one whose session never came back.
export { abandonedFleets, createFleetLedger } from "./fleet.js";
// Whether the install a session pins its children to is still there,
// and how to tell a child that died of its absence. Exported because
// the round above has to say that once rather than per reviewer, and
// only this side can tell a broken session from a broken reviewer.
export {
	detectStaleInstallInStderr,
	STALE_RUNTIME_WARNING_PREFIX,
} from "./health.js";
// Parent-install resolution (pins subagents to the running install).
export {
	getParentPiInstall,
	type PiInstall,
	type ResolvePiInstallDeps,
	resolveParentPiInstall,
} from "./install.js";
export type {
	LeaseRecord,
	ProcessFacts,
	SupervisorStanding,
} from "./lease.js";
export {
	HEARTBEAT_STALE_MS,
	SAME_PROCESS_MS,
	sameProcess,
	supervisorStanding,
	systemFacts,
} from "./lease.js";
export {
	type ReapedReviewerChild,
	type ReaperDeps,
	type RecoveredReviewerProgress,
	type RecoveredReviewerResult,
	type RecoverySummary,
	recoverReviewerRuns,
} from "./recovery.js";
// Reviewer error classification.
export {
	classifyReviewerError,
	describeReviewerError,
	type ReviewerError,
	type ReviewerErrorClass,
} from "./reviewer-error.js";
// Runner implementations.
export { createSpawnRunPi } from "./runpi/spawn.js";
export {
	createSupervisorRunPi,
	createSupervisorStartPi,
	type StartedPi,
	type StartPi,
} from "./runpi/supervisor.js";
// Stream parsing (advanced consumers).
export {
	type ReviewerStreamLimits,
	ReviewerStreamParser,
	type ReviewerStreamResult,
} from "./stream.js";
// Spec, job and run plumbing.
export type {
	CouncilReviewer,
	FleetResult,
	ReviewerRunArtifacts,
	ReviewerThinkingLevel,
	ReviewerUsage,
	ReviewerVerification,
	RunPi,
	RunPiResult,
	RunPiStreamEvent,
	RunReviewerOptions,
	RunReviewerResult,
	StartReviewerOptions,
	SubagentJob,
	SubagentRunResult,
	SubagentSpec,
	SubagentUsage,
	SubagentVerification,
	VerifyPack,
} from "./subagent.js";
export {
	extractUsageFromPiStream,
	// The three halves of one fact about the journal: where the pack
	// is, what its tool is called, and the variable naming the file it
	// writes. Exported because the pack, the supervisor and the
	// dispatcher are three processes that have to agree, and a second
	// spelling in any of them fails silently.
	JOURNAL_PACK_PATH,
	JOURNAL_PATH_VAR,
	JOURNAL_TOOL_NAME,
	// Exported for the one caller that has to redo what a live run
	// already did: reading a reviewer's directories back off disk after
	// the session that ran them is gone. A second copy of these rules
	// would decide differently about which answer is the real one.
	mergeResumeOutcome,
	mergeWrapUpOutcome,
	// The same reason: a caller reading a stopped reviewer's work off
	// disk has to look in all three of its directories, and a second
	// spelling of the suffixes is a second answer to where they are.
	RESUME_SUFFIX,
	runFleet,
	runReviewer,
	runSubagent,
	startReviewer,
	VERIFY_TOOL_NAME,
	verifyProtocolInstruction,
	WRAP_UP_SUFFIX,
} from "./subagent.js";

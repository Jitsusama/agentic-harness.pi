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
 * - `createSpawnRunPi` — fire-and-forget; the child dies
 *   with the parent. Cheapest path; suitable for council
 *   fan-outs inside an interactive session.
 * - `createSupervisorRunPi` — durable; each run lives
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

// Durable artifacts and recovery (supervisor path).
export { ReviewerArtifactsStore } from "./artifacts.js";
// Engine-wide always-load defaults.
export {
	clearSubagentDefaults,
	getSubagentDefaults,
	registerSubagentDefaultExtension,
	registerSubagentDefaultSkill,
} from "./defaults.js";
// Parent-install resolution (pins subagents to the running install).
export {
	type PiInstall,
	type ResolvePiInstallDeps,
	resolveParentPiInstall,
} from "./install.js";
export {
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
export { createSupervisorRunPi } from "./runpi/supervisor.js";
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
	SubagentJob,
	SubagentRunResult,
	SubagentSpec,
	SubagentUsage,
	SubagentVerification,
	VerifyPack,
} from "./subagent.js";
export {
	extractUsageFromPiStream,
	runFleet,
	runReviewer,
	runSubagent,
	VERIFY_TOOL_NAME,
	verifyProtocolInstruction,
} from "./subagent.js";

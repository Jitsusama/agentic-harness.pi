/**
 * What a reviewer run is asked and what it answers.
 *
 * The shapes the dispatcher, its runners and its callers agree on: who
 * the subagent is, what one pi process is handed and hands back, and
 * what a reviewer's run returns. They change when that agreement does,
 * which is apart from how a run is started, followed up or read back.
 * `subagent.ts` re-exports every one, so callers name them from there.
 */

import type { ThinkingLevel } from "../thinking/index.ts";
// Type-only, and erased, so the pairing with artifacts.ts importing
// ReviewerRunArtifacts back out of the dispatcher is not a runtime
// cycle. The state belongs beside the store that writes it and the
// result that reports it, and those are two files.
import type { ReviewerTerminalState } from "./artifacts.ts";
import type { ReviewerError } from "./reviewer-error.ts";
import type { RoomCode, RoomPlace } from "./runpi/room-launch.ts";
import type { StartPi } from "./runpi/supervisor.ts";

/** File-backed artifacts emitted by a supervised reviewer run. */
export interface ReviewerRunArtifacts {
	readonly runDir: string;
	readonly reviewerDir: string;
	readonly eventsPath: string;
	readonly stderrPath: string;
	readonly progressPath: string;
	readonly resultPath: string;
	/**
	 * File the reviewer's verify_output tool writes its
	 * validated payload to. The supervisor reads it back
	 * out-of-band so a large review never rides the
	 * size-capped event stream.
	 */
	readonly verifiedOutputPath: string;
	/**
	 * File the reviewer appends a finding to the moment it
	 * forms one, rather than saving them all for its answer.
	 *
	 * One JSON object per line, so a reviewer stopped partway
	 * through writing costs the line it was on and nothing
	 * before it. Everything else about a stop is recovery,
	 * which only works if the answer arrives; this does not
	 * need the reviewer to live long enough to say it twice.
	 *
	 * Absent from a runner that keeps no artifacts, which has
	 * nowhere to put one.
	 */
	readonly journalPath?: string;
	/**
	 * Private per-reviewer directory pi persists the session
	 * into (via --session-dir). Kept out of the user's session
	 * list so a supervised run leaves no trace there.
	 */
	readonly sessionDir?: string;
	/**
	 * The session file pi minted inside sessionDir, discovered
	 * after the run. Absent when the reviewer crashed before
	 * writing a session. This is what a resume reopens.
	 */
	readonly sessionPath?: string;
}

/**
 * A subagent spec: identity, model, thinking level, tool
 * palette. This is the per-job input the engine reads, and
 * a review round uses the same shape to describe one
 * participant. The `CouncilReviewer` alias below is
 * retired once its remaining callers use this name.
 */
export interface SubagentSpec {
	/** Stable id used in finding origin and result correlation. */
	readonly id: string;
	/**
	 * Pi `--model` value. Either a bare model id
	 * (`claude-opus-4-7`) or a `provider/model` pair
	 * (`anthropic/claude-opus-4-7`). The colon form
	 * `provider:model` is NOT accepted by pi's CLI; colons
	 * are reserved for the `model:thinking` shorthand.
	 *
	 * Omit to use pi's configured `defaultModel`. The child is a
	 * fresh pi process and nothing hands it the parent's model, so a
	 * parent switched to another model mid-session still spawns
	 * children on the settings default.
	 */
	readonly model?: string;
	/**
	 * Pi `--thinking` value: `off`, `low`, `medium`, or
	 * `high`. Omit to use pi's configured `defaultThinkingLevel`,
	 * not the parent session's current level.
	 */
	readonly thinkingLevel?: ReviewerThinkingLevel;
	/** Pi `--tools` palette (e.g. ["read", "grep", "bash"]). */
	readonly tools?: readonly string[];
}

/**
 * Legacy alias for {@link SubagentSpec}, from when the only
 * caller was a council of reviewers. Kept because callers
 * still name it; removed once they say `SubagentSpec`.
 */
export type CouncilReviewer = SubagentSpec;

/**
 * Thinking levels accepted by pi's `--thinking` flag.
 *
 * The shared list, not a fourth copy of it. This one and the roster
 * parser's used to be written out separately in domains that share no
 * module, which is a disagreement waiting to happen in the one place
 * it cannot be seen: a level one accepts and pi does not.
 */
export type ReviewerThinkingLevel = ThinkingLevel;

export interface ReviewerVerification {
	/** Whether the reviewer called verify_output at least once. */
	readonly called: boolean;
	/** Whether the last verify_output call returned ok: true. */
	readonly ok: boolean;
	/**
	 * How many times verify_output ran before the recorded
	 * result. One means the first attempt was the last; higher
	 * means the reviewer retried to reach a valid payload.
	 */
	readonly attempts?: number;
	/** Stage passed to verify_output, when available. */
	readonly stage?: string;
	/** Count returned by the verifier on success. */
	readonly count?: number;
	/** Verifier warning rows, such as stringified-output coercion. */
	readonly warnings?: readonly string[];
	/** Human-readable result text from the verifier. */
	readonly message?: string;
	/** The output object from a successful verification. */
	readonly output?: unknown;
	/** Whether finalAssistantText was materialized from the verified payload. */
	readonly canonicalText?: boolean;
	/**
	 * Whether the output arrived out-of-band, from the
	 * verify-output file rather than the event stream. When
	 * set, the payload bypassed every stream and text size
	 * cap, so the parent must not re-apply them.
	 */
	readonly outOfBand?: boolean;
}

export interface RunPiResult {
	/** Raw stdout. Legacy runners may still return this; supervised runners should not. */
	readonly stdout?: string;
	/** Raw stderr. Legacy runners may still return this; supervised runners should prefer stderrTail. */
	readonly stderr?: string;
	readonly exitCode: number;
	/** Extracted assistant output. Present for supervised, file-backed runners. */
	readonly finalAssistantText?: string;
	/** Extracted usage. Present when the stream carried usage data. */
	readonly usage?: ReviewerUsage;
	/**
	 * Every session the child announced, when the runner watched its
	 * whole stream. Absent from a runner that cannot say.
	 */
	readonly sessionIds?: readonly string[];
	/** Runner-level warnings from streaming, supervision or recovery. */
	readonly warnings?: readonly string[];
	/** Bounded stderr tail fit for warnings and diagnostics. */
	readonly stderrTail?: string;
	/** Result of the reviewer's verify_output calls, when observed. */
	readonly verification?: ReviewerVerification;
	/**
	 * Findings the reviewer wrote down as it worked, read back
	 * off its journal. Unparsed: whoever asked knows what a
	 * finding is, and this does not.
	 */
	readonly journal?: readonly unknown[];
	/**
	 * What went wrong reading the journal back, when something
	 * did. Its own field because these say findings were left
	 * behind, and a caller that replaces the general warnings
	 * with a sentence of its own drops exactly those.
	 */
	readonly journalWarnings?: readonly string[];
	/**
	 * The terminal turn's error, when the run ended on a
	 * provider or transport failure rather than a clean stop.
	 */
	readonly error?: ReviewerError;
	/** Durable files backing this run, when available. */
	readonly artifacts?: ReviewerRunArtifacts;
	/**
	 * How the run ended, as the supervisor classified it.
	 *
	 * An exit code cannot say this. A reviewer stopped at a wall clock
	 * and one that answered badly can both arrive with text and a
	 * non-zero code, and a caller that cannot tell them apart blames
	 * the reviewer for a deadline we set. Absent from unsupervised
	 * runners, which never knew.
	 */
	readonly state?: ReviewerTerminalState;
}

/** One pi `--mode json` stream event. */
export type RunPiStreamEvent = Record<string, unknown>;

/**
 * A wrap-up spelled out for a supervisor to start on its own: pi's
 * arguments, holding `--session` for the supervisor to fill with the
 * session the stopped run left, the id it runs under, and its clocks.
 */
export interface WrapUpRequest {
	readonly reviewerId: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	readonly idleTimeoutMs: number;
}

/** Injectable subprocess runner. */
export type RunPi = (opts: {
	readonly args: string[];
	readonly cwd: string;
	readonly runId?: string;
	readonly reviewerId?: string;
	readonly signal?: AbortSignal;
	/**
	 * Optional live-stream hook. Fires per parsed JSON
	 * event line as the subprocess emits it. Errors
	 * thrown inside the callback are swallowed so a
	 * broken observer can't kill the run.
	 */
	readonly onEvent?: (event: RunPiStreamEvent) => void;
	/**
	 * How much of the wall clock to keep back for an answer.
	 *
	 * A reserve rather than a deadline, because only the runner
	 * knows what the wall clock actually is: the caller may not
	 * have set one, and the configured default lives here. Given
	 * one, the supervisor stops the run that much before its
	 * deadline so the rest can be spent asking for what it has.
	 */
	readonly wrapUpReserveMs?: number;
	/**
	 * What to ask a run a clock stopped, when nobody is waiting to ask
	 * it: the supervisor starts this itself, on the session the run left.
	 * Only the runner that walks away reads it; a waiting caller asks.
	 */
	readonly wrapUp?: WrapUpRequest;
	/**
	 * Whether this run should persist its pi session so a
	 * later resume can reopen it. Defaults to false: a run is
	 * ephemeral unless the caller asks to keep the transcript.
	 * The reviewer path sets it true (paired with autoResume);
	 * fleet jobs leave it false and stay ephemeral.
	 */
	readonly persistSession?: boolean;
	/**
	 * Per-call hard wall-clock timeout in milliseconds.
	 * Overrides the runner's configured default. Use for
	 * one-off long-running subagents (soak tests, recovery
	 * runs) without bumping the global default.
	 */
	readonly timeoutMs?: number;
	/**
	 * Per-call idle timeout in milliseconds: how long the
	 * supervisor will wait between supervisor protocol
	 * events before declaring the child stuck. Overrides
	 * the runner's configured default. Set high when the
	 * subagent issues long-running bash commands that don't
	 * stream progress (deploys, benchmarks). Non-supervising
	 * runners (e.g. the raw spawn runner) ignore the value
	 * and surface a one-line warning on the result so the
	 * caller knows the override didn't apply.
	 */
	readonly idleTimeoutMs?: number;
	/**
	 * Variables this run's pi takes on top of the session's, such as
	 * `PI_SANDBOX`. Given to the process as it starts and never written
	 * to the run's request on disk, so a resume or wrap-up takes them
	 * from whoever starts it again, not from what an earlier run saved.
	 */
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * A room to run this reviewer on, and the code it reads there.
	 * The supervisor starts it there first and here only when the room
	 * gave nothing back; a run whose words the room's entry would
	 * refuse stays here from the start. Only the supervised runners
	 * read it.
	 */
	readonly room?: RoomAsk;
}) => Promise<RunPiResult>;

/** Where a reviewer would run on a room, and the commit it reads there. */
export interface RoomAsk {
	readonly place: RoomPlace;
	readonly code: RoomCode;
}

/** Inputs `runReviewer` needs to dispatch one pi process. */
/**
 * Pre-dispatch health probe injected into `runReviewer`.
 *
 * Returns a structured error when the running pi binary
 * has disappeared from disk (typical cause: pi upgraded
 * mid-session and the old nix store entry was garbage-
 * collected). Returns `null` when dispatch is safe.
 */
export type SubagentRuntimeCheck = () => {
	readonly path: string;
	readonly message: string;
} | null;

export interface RunReviewerOptions {
	readonly reviewer: CouncilReviewer;
	/**
	 * The brief: what every reviewer of a round is sent alike.
	 *
	 * Handed to pi as a file named by its content, so reviewers sent the
	 * same brief open their requests with the same bytes, path and all.
	 */
	readonly prompt: string;
	/**
	 * What this reviewer alone is told, after the brief.
	 *
	 * Apart from the brief because the two are cached apart. A round's
	 * reviewers share everything up to the end of the brief, and a
	 * reviewer given an ask also loads the pack that marks that end for
	 * caching, so the first reviewer's write is one the rest can read.
	 * Passed on argv rather than in a file, so it stays small.
	 */
	readonly ask?: string;
	/** Working directory for the subprocess (worktree path). */
	readonly cwd: string;
	/**
	 * Variables the reviewer's pi takes on top of the session's, given to
	 * its run, its wrap-up and its resume alike. The council sets
	 * `PI_SANDBOX=strict` here, since a reviewer reads a stranger's change.
	 */
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * A room to run the reviewer on first, and the commit it reads
	 * there. Its first run only: a resume or wrap-up needs the session
	 * a room run does not keep, so it runs here.
	 */
	readonly room?: RoomAsk;
	/**
	 * Optional system prompt forwarded to pi via
	 * `--system-prompt`. Callers use this to set the
	 * subagent's persona, baseline instructions or
	 * voice before the user prompt arrives. When omitted,
	 * pi falls back to its session default.
	 */
	readonly systemPrompt?: string;
	/**
	 * When true, ask pi to ignore every form of ambient
	 * inheritance (`--no-skills --no-context-files
	 * --no-extensions`). The subagent then sees only the
	 * `extraExtensions`, `extraSkills` and prompts the
	 * caller passes in. Used for clean-slate fleet runs
	 * where the user's local pi setup must not bleed in.
	 */
	readonly isolated?: boolean;
	/**
	 * When true, ask pi to ignore project-local files
	 * (`--no-approve`) even when not isolated, so a
	 * folder's `.pi` is never loaded as the subagent's code.
	 */
	readonly ignoreProject?: boolean;
	/** Cancellation hook; propagates to the subprocess. */
	readonly signal?: AbortSignal;
	/** Subprocess runner. Inject a fake for tests. */
	readonly runPi: RunPi;
	/** Durable run id used by supervised reviewer jobs. */
	readonly runId?: string;
	/**
	 * Absolute paths of sibling extensions to inject
	 * into the subagent via `--extension`. Used by the
	 * council orchestrator to load the verify-output
	 * surface (and any future parent-side helpers) so the
	 * subagent can self-validate before ending. Pi auto-
	 * discovery still applies for the user's own globals;
	 * these layer on top.
	 */
	readonly extraExtensions?: readonly string[];
	/**
	 * Absolute paths of skill files to inject into the
	 * subagent via `--skill`. Used to teach the subagent
	 * its output contract without baking the prose into
	 * the prompt body. Loads in addition to whatever the
	 * user's pi setup auto-discovers.
	 */
	readonly extraSkills?: readonly string[];
	/**
	 * Whether the engine should enforce that the subagent
	 * called `verify_output` and got `ok: true` before
	 * accepting the run. Set this when injecting a verify
	 * extension via `extraExtensions`; otherwise the
	 * subagent's output is taken as-is. Defaults to
	 * `false`.
	 */
	readonly requiresVerification?: boolean;
	/**
	 * Optional stage label the subagent must echo back
	 * through `verify_output`. When set, a stage mismatch
	 * is treated as verification failure even if the tool
	 * returned `ok: true`. Opaque to the engine; callers
	 * choose their own stage vocabulary.
	 */
	readonly expectedVerificationStage?: string;
	/**
	 * Live event hook forwarded to the subprocess
	 * runner. The council orchestrator uses this to
	 * translate the reviewer's per-line stream into
	 * progress updates ("reading task.go", "running
	 * bash...") so the user sees signal mid-flight instead
	 * of dead air.
	 */
	readonly onEvent?: (event: RunPiStreamEvent) => void;
	/**
	 * Per-call hard wall-clock timeout in milliseconds.
	 * Forwarded to `runPi`. Overrides the runner's
	 * configured default for this one call.
	 */
	readonly timeoutMs?: number;
	/**
	 * How much of that wall clock to keep back so this reviewer
	 * can be asked for its answer before the deadline takes it.
	 *
	 * Defaults to the wrap-up's own budget, which is the number
	 * that makes the two agree: the time reserved is the time the
	 * wrap-up is allowed. Ignored when `autoResume` is false,
	 * since a run that cannot be resumed cannot be asked.
	 */
	readonly wrapUpReserveMs?: number;
	/**
	 * Per-call idle timeout in milliseconds. Forwarded to
	 * `runPi`. Overrides the runner's configured default
	 * for this one call. Use when the subagent will issue
	 * long-running bash commands that stay silent on
	 * stdout.
	 */
	readonly idleTimeoutMs?: number;
	/**
	 * Runtime health probe. Defaults to the module-level
	 * `checkSubagentRuntime` bound to `process.execPath`.
	 * Tests inject a fake to exercise the stale-runtime
	 * short-circuit without touching the real binary.
	 */
	readonly checkRuntime?: SubagentRuntimeCheck;
	/**
	 * Whether to automatically resume once when the run ends
	 * on a transient error and a session was persisted.
	 * Defaults to true. The resume reopens the reviewer's own
	 * session, so its investigation is not re-run; only the
	 * final synthesis reruns, riding the prompt cache. Resume
	 * is a no-op unless a session was persisted, so a caller
	 * that does not persist one (the fleet path) never resumes
	 * regardless; set false to opt out explicitly, which
	 * deterministic tests do.
	 */
	readonly autoResume?: boolean;
}

/** Token + cost figures for one reviewer subagent run. */
export interface ReviewerUsage {
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

/** Result of one reviewer's run. */
export interface RunReviewerResult {
	readonly reviewerId: string;
	readonly exitCode: number;
	readonly finalAssistantText: string;
	/**
	 * What the run had said before it was stopped, when it was later
	 * asked for its findings and answered.
	 *
	 * Kept apart rather than joined onto the answer. Joined, it reads as
	 * one answer to anything that parses this, and two objects are not
	 * one: the reader falls through to salvaging a truncated answer,
	 * reports a complete wrap-up as cut off, and can prefer the fragment
	 * over it. Which of the two holds the better answer is a question
	 * only something able to read findings can settle, and nothing here
	 * can.
	 */
	readonly priorAssistantText?: string;
	/** Whether a stopped run was asked for its findings and gave them. */
	readonly wrappedUp?: boolean;
	/**
	 * Findings the reviewer wrote down while it worked, rather
	 * than saving them for its answer. On the wire, because a
	 * finding belongs to a round and this does not know one.
	 */
	readonly journal?: readonly unknown[];
	/** What went wrong reading that journal back, if anything. */
	readonly journalWarnings?: readonly string[];
	readonly stderr: string;
	readonly warnings: string[];
	/**
	 * Token + cost totals summed across every assistant
	 * message_end event in the run. `undefined` when the
	 * stream carried no usage block (older pi, fake runners).
	 */
	readonly usage?: ReviewerUsage;
	/**
	 * Every pi session the run's processes announced, in order, which
	 * are the ids the AI proxy bills them under. A stopped reviewer asked
	 * for its findings, or a dropped one resumed, adds a process and so a
	 * session. Null when any process's runner could not say, since a
	 * partial list would join the run to less than its bill.
	 */
	readonly sessionIds: readonly string[] | null;
	/** Result of the reviewer's verify_output calls, when observed. */
	readonly verification?: ReviewerVerification;
	/**
	 * The terminal turn's error, when the run ended on a
	 * provider or transport failure rather than a clean stop.
	 * Carried through so the dispatcher can tell a dropped
	 * reviewer from one that merely never verified, and decide
	 * whether the failure is worth resuming.
	 */
	readonly error?: ReviewerError;
	/**
	 * How the run ended, when a supervised runner classified it.
	 *
	 * The one thing that separates a reviewer we stopped from one
	 * that answered badly, and neither the exit code nor the text
	 * can carry it.
	 */
	readonly state?: ReviewerTerminalState;
}

/** What starting a reviewer needs, which is less than running one. */
export type StartReviewerOptions = Omit<
	RunReviewerOptions,
	"runPi" | "signal" | "onEvent" | "autoResume"
> & {
	/** Dispatch it and return; nothing will wait for it. */
	readonly startPi: StartPi;
	/** Root of the reviewer artifact tree, where the prompt is kept. */
	readonly stateDir: string;
};

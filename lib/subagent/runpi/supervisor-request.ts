/**
 * What a supervisor is told, and what it runs with: the runners'
 * configuration and its defaults, the request file each run writes,
 * the environment a supervisor and its reviewer take, and where the
 * supervisor script is.
 *
 * Shared by the runner that waits and the one that walks away, so the
 * two cannot tell a supervisor different things.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hosted, sessionOwner } from "../../core/session/index.ts";
import { withoutOff } from "../../internal/fence/fence-stage.ts";
import { offeredShellEnvironment } from "../../internal/shell/environment.ts";
import { ReviewerArtifactsStore, type ReviewerRunPaths } from "../artifacts.ts";
import { pinnedChildEnvironment } from "../child-env.ts";
import type { PiInstall } from "../install.ts";
import type { RunPi } from "../subagent.ts";

/** Subset of `child_process.spawn`'s signature we depend on. */
export type SupervisorSpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

/** Configuration for supervised reviewer subprocesses. */
export interface SupervisorRunPiConfig {
	/**
	 * The pinned parent pi install. The supervisor launches
	 * each reviewer as `install.node install.entry ...args`
	 * so it runs the parent's exact install rather than
	 * whatever bare `pi` resolves to on PATH.
	 */
	readonly piInstall: PiInstall;
	readonly stateDir: string;
	readonly nodeBinary?: string;
	readonly supervisorPath?: string;
	readonly spawn?: SupervisorSpawnFn;
	readonly timeoutMs?: number;
	/**
	 * How long past its own deadline a supervisor gets before the
	 * parent stops waiting. Only worth setting to keep a test that
	 * exercises the backstop from spending the default on waiting.
	 */
	readonly supervisorGraceMs?: number;
	readonly idleTimeoutMs?: number;
	readonly killGraceMs?: number;
	readonly maxEventBytes?: number;
	readonly maxEventRotations?: number;
	readonly maxStderrBytes?: number;
	readonly maxStderrRotations?: number;
	readonly stderrTailBytes?: number;
	readonly maxLineBytes?: number;
	readonly maxAssistantTextBytes?: number;
	readonly maxWarnings?: number;
	/**
	 * How long the provider keeps the child's prompt cached, as
	 * `PI_CACHE_RETENTION` says it, in place of what the session runs
	 * with. Left out, the child keeps the session's.
	 */
	readonly cacheRetention?: "short" | "long";
}

/** The wall clock a run gets when neither it nor the config names one. */
export const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** How long a stopped reviewer gets between the ask and the kill. */
export const DEFAULT_KILL_GRACE_MS = 5 * 1000;
const DEFAULT_MAX_EVENT_BYTES = 10 * 1024 * 1024;
/**
 * How many rotated segments of a subagent's event stream to keep before
 * the oldest is deleted.
 *
 * The oldest segment holds the start of the run, so deleting it loses
 * the session header and the first turns before anything has had a
 * chance to digest them. At three, that happened past 40 MB of events,
 * and the largest real stream had already reached its second rotation.
 * Rotated segments are gzipped at roughly ten to one and are reclaimed
 * once digested, so a much higher ceiling is cheap and transient while
 * losing the head is permanent.
 */
const DEFAULT_MAX_EVENT_ROTATIONS = 32;
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_ROTATIONS = 3;
/** How much of a supervisor's stderr is kept to report. */
export const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ASSISTANT_TEXT_BYTES = 512 * 1024;
const DEFAULT_MAX_WARNINGS = 20;

/**
 * Rewrite composed reviewer args to persist the session.
 *
 * The composed args default to `--no-session` because the
 * fleet and legacy runners want ephemeral runs. The
 * supervisor owns a private per-reviewer artifacts
 * directory, so it swaps that flag for `--session-dir
 * <dir>`, giving a dropped reviewer a session to resume
 * without ever writing to the user's session list. When the
 * flag is absent the session dir is appended.
 */
export function withSessionPersistence(
	args: readonly string[],
	sessionDir: string,
): string[] {
	// A resume already names its session file with --session,
	// and an explicit --session-dir is honoured as-is. Either
	// way the session is handled, so leave the args untouched.
	if (args.includes("--session") || args.includes("--session-dir")) {
		return [...args];
	}
	const index = args.indexOf("--no-session");
	if (index === -1) {
		return [...args, "--session-dir", sessionDir];
	}
	return [
		...args.slice(0, index),
		"--session-dir",
		sessionDir,
		...args.slice(index + 1),
	];
}

/**
 * What a supervisor and its reviewer run with: pi's own environment
 * and what the session offers its commands, such as the loaded quest.
 * A subagent does its session's work, so the machine counts it for the
 * same quest. A runner that names a cache retention gives it in place of
 * the session's. What the process pinned for its children, such as a
 * host's gateway key, goes over those. The run's own variables go on top,
 * on the supervisor rather than in its request, since the reviewer takes
 * the supervisor's environment and a request on disk outlives the run
 * that wrote it.
 */
export async function supervisorEnvironment(
	config: SupervisorRunPiConfig,
	given: Readonly<Record<string, string>> | undefined,
): Promise<NodeJS.ProcessEnv> {
	return {
		// A session set off is so alone, never its subagents (fence-stage.ts).
		...withoutOff(process.env),
		...offeredShellEnvironment(),
		...(config.cacheRetention === undefined
			? {}
			: { PI_CACHE_RETENTION: config.cacheRetention }),
		...(await pinnedChildEnvironment()),
		...given,
	};
}

/** Where the supervisor script is and what runs it. */
export function supervisorPlaces(config: SupervisorRunPiConfig): {
	script: string;
	nodeBinary: string;
} {
	return {
		script:
			config.supervisorPath ??
			fileURLToPath(new URL("./supervisor.mjs", import.meta.url)),
		nodeBinary: config.nodeBinary ?? process.execPath,
	};
}

/**
 * Make a reviewer's directory and write down what it is being asked.
 *
 * Shared by the runner that waits and the one that walks away,
 * because everything a supervisor needs is in this file and neither
 * caller adds anything to it. Two copies would be two answers to
 * questions like whether a detached reviewer persists its session,
 * and the detached one is exactly where that has to be true: a
 * session is what a resume reads.
 */
export async function told(
	config: SupervisorRunPiConfig,
	options: Parameters<RunPi>[0],
	/**
	 * Whether the caller is going to walk away.
	 *
	 * Required rather than defaulted, because the two runners want
	 * opposite answers and the wrong one is silent: a detached round
	 * that inherits the waiting path's parent pid dies with the
	 * session and looks exactly like a round nobody started.
	 */
	orphaned: boolean,
): Promise<{
	paths: Awaited<ReturnType<ReviewerArtifactsStore["ensureReviewerDir"]>>;
	runId: string;
	reviewerId: string;
}> {
	const store = new ReviewerArtifactsStore(config.stateDir);
	const runId = options.runId ?? `reviewer-${Date.now()}`;
	const reviewerId = options.reviewerId ?? "reviewer";
	const paths = await store.ensureReviewerDir(runId, reviewerId);
	const root = store.rootPaths(runId);
	const request = await buildRequest(
		config,
		paths,
		root.cancelPath,
		{
			runId,
			reviewerId,
			binary: config.piInstall.node,
			// Pin the child's asset resolution (theme, package.json)
			// to the parent's dereferenced install. The supervisor
			// sets PI_PACKAGE_DIR from this so a mid-session upgrade
			// that deletes the versioned symlink cannot strand the
			// child on a path that no longer exists.
			...(config.piInstall.packageDir
				? { piPackageDir: config.piInstall.packageDir }
				: {}),
			// Only persist the session when the caller asked for
			// it (the reviewer path, to enable resume). Fleet jobs
			// leave persistSession false and stay ephemeral on the
			// composed `--no-session`.
			args: [
				config.piInstall.entry,
				...(options.persistSession
					? withSessionPersistence(options.args, paths.sessionDir)
					: options.args),
			],
			cwd: options.cwd,
			...(orphaned ? { orphaned } : {}),
		},
		{
			...(options.timeoutMs !== undefined
				? { timeoutMs: options.timeoutMs }
				: {}),
			...(options.idleTimeoutMs !== undefined
				? { idleTimeoutMs: options.idleTimeoutMs }
				: {}),
			...(options.wrapUpReserveMs !== undefined
				? { wrapUpReserveMs: options.wrapUpReserveMs }
				: {}),
		},
	);
	await store.writeJsonAtomic(paths.requestPath, request);
	return { paths, runId, reviewerId };
}

/**
 * The wall clock, and where inside it to ask for an answer.
 *
 * Computed together because they are one decision. The caller says
 * how much time to keep back and this is the only place that knows
 * what it is keeping it back from, since an unset timeout means the
 * configured default rather than no deadline at all.
 *
 * A reserve is refused rather than honoured when it would leave the
 * reviewer less time to work than to wrap up. Something has been
 * misconfigured at that point, and the safe reading is that the run
 * wants its full budget: wrapping up before it has done anything
 * would spend the whole clock asking for findings nobody had time to
 * form.
 */
function softDeadline(
	wall: number,
	reserve: number | undefined,
): { timeoutMs: number; softDeadlineMs?: number } {
	// Zero is the documented off switch, and it has to mean that here
	// too. Left to the arithmetic it yields a soft deadline exactly
	// equal to the wall clock: not off, just inert, and inert in a way
	// that reads as configured to anybody looking at the request file.
	if (reserve === undefined || reserve === 0 || wall <= reserve * 2) {
		return { timeoutMs: wall };
	}
	return { timeoutMs: wall, softDeadlineMs: wall - reserve };
}

async function buildRequest(
	config: SupervisorRunPiConfig,
	paths: ReviewerRunPaths,
	runCancelPath: string,
	input: {
		readonly runId: string;
		readonly reviewerId: string;
		readonly binary: string;
		readonly piPackageDir?: string;
		readonly args: readonly string[];
		readonly cwd: string;
		/** Nobody is waiting, so the parent's death means nothing. */
		readonly orphaned?: boolean;
	},
	overrides: {
		readonly timeoutMs?: number;
		readonly idleTimeoutMs?: number;
		readonly wrapUpReserveMs?: number;
	} = {},
): Promise<unknown> {
	const parentOwner =
		!input.orphaned && hosted() ? await sessionOwner() : undefined;
	return {
		schemaVersion: 1,
		...(parentOwner ? { parentOwner } : {}),
		...input,
		// Only when somebody is waiting. The supervisor stops its child
		// as soon as this pid is gone, which is right for a round the
		// session is holding and fatal for one it deliberately let go:
		// a detached round would be killed within half a second of the
		// session exiting, which is the whole thing it exists not to do.
		...(input.orphaned ? {} : { parentPid: process.pid }),
		paths,
		runCancelPath,
		...softDeadline(
			overrides.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			overrides.wrapUpReserveMs,
		),
		idleTimeoutMs:
			overrides.idleTimeoutMs ??
			config.idleTimeoutMs ??
			DEFAULT_IDLE_TIMEOUT_MS,
		killGraceMs: config.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
		maxEventBytes: config.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
		maxEventRotations: config.maxEventRotations ?? DEFAULT_MAX_EVENT_ROTATIONS,
		maxStderrBytes: config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
		maxStderrRotations:
			config.maxStderrRotations ?? DEFAULT_MAX_STDERR_ROTATIONS,
		stderrTailBytes: config.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES,
		maxLineBytes: config.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
		maxAssistantTextBytes:
			config.maxAssistantTextBytes ?? DEFAULT_MAX_ASSISTANT_TEXT_BYTES,
		maxWarnings: config.maxWarnings ?? DEFAULT_MAX_WARNINGS,
	};
}

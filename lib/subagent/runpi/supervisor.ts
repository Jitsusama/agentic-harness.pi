import {
	type ChildProcess,
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	ReviewerArtifactsStore,
	type ReviewerRunPaths,
	type ReviewerTerminalState,
} from "../artifacts.js";
import type { PiInstall } from "../install.js";
import type { ReviewerError } from "../reviewer-error.js";
import type { RunPi, RunPiResult } from "../subagent.js";

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
}

interface SupervisorResultFile {
	readonly state?: ReviewerTerminalState;
	readonly exitCode: number;
	readonly finalAssistantText: string;
	readonly usage?: RunPiResult["usage"];
	readonly warnings?: readonly string[];
	readonly stderrTail?: string;
	readonly verification?: RunPiResult["verification"];
	readonly error?: ReviewerError;
	readonly artifacts?: RunPiResult["artifacts"];
}

/**
 * How long a departed supervisor's pipes may stay open before the
 * run is settled from disk anyway. Long enough for an ordinary
 * flush, short enough that nobody calls it a hang.
 *
 * Two seconds was measured to be too short. On a loaded runner the
 * sequence still to happen after exit is a grandchild spawn, a
 * stdout flush through inherited pipes and an atomic result write,
 * and when that overran the grace the run settled from a file that
 * was not there yet and reported an empty answer. An empty answer
 * is the worst available failure, because it looks like a reviewer
 * that said nothing rather than a deadline that was too tight.
 * Five seconds is still nobody's idea of a hang.
 */
const STDIO_GRACE_MS = 5_000;

/**
 * How long past its own deadline a supervisor gets before the
 * parent stops waiting.
 *
 * Room for a slow start and a final write on a loaded machine,
 * without turning a wedged run into an unbounded one.
 */
const SUPERVISOR_GRACE_MS = 10_000;

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5 * 1000;

/**
 * What the supervisor's own shutdown needs after its last watchdog
 * fires, beyond signalling and pipe draining: several atomic writes,
 * a session-directory discovery and an out-of-band verification read.
 *
 * Generous on purpose. This is the margin that decides whether the
 * supervisor reports its own verdict or gets killed mid-sentence, and
 * the machines where it matters are the loaded ones where every one of
 * those writes is slow.
 */
const FINISH_WRITE_MARGIN_MS = 15 * 1000;
const DEFAULT_MAX_EVENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_EVENT_ROTATIONS = 3;
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_ROTATIONS = 3;
const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;
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

/** Build a `RunPi` backed by durable reviewer supervisor jobs. */
export function createSupervisorRunPi(config: SupervisorRunPiConfig): RunPi {
	const spawnFn = config.spawn ?? (nodeSpawn as SupervisorSpawnFn);
	const store = new ReviewerArtifactsStore(config.stateDir);
	const supervisorPath =
		config.supervisorPath ??
		fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
	const nodeBinary = config.nodeBinary ?? process.execPath;

	return async function runPi({
		args,
		cwd,
		signal,
		onEvent,
		runId,
		reviewerId,
		persistSession,
		timeoutMs,
		idleTimeoutMs,
	}) {
		const effectiveRunId = runId ?? `reviewer-${Date.now()}`;
		const effectiveReviewerId = reviewerId ?? "reviewer";
		const paths = await store.ensureReviewerDir(
			effectiveRunId,
			effectiveReviewerId,
		);
		const root = store.rootPaths(effectiveRunId);
		const request = buildRequest(
			config,
			paths,
			root.cancelPath,
			{
				runId: effectiveRunId,
				reviewerId: effectiveReviewerId,
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
					...(persistSession
						? withSessionPersistence(args, paths.sessionDir)
						: args),
				],
				cwd,
			},
			{
				...(timeoutMs !== undefined ? { timeoutMs } : {}),
				...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
			},
		);
		await store.writeJsonAtomic(paths.requestPath, request);

		return new Promise<RunPiResult>((resolve, reject) => {
			const supervisor = spawnFn(
				nodeBinary,
				[supervisorPath, paths.requestPath],
				{
					cwd,
					detached: false,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let settled = false;
			let stdoutBuffer = "";
			let stderrTail = "";
			let terminalResultPath: string | null = null;
			const warnings: string[] = [];
			const settle = async (fn: () => Promise<RunPiResult>): Promise<void> => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				signal?.removeEventListener("abort", abortHandler);
				try {
					resolve(await fn());
				} catch (error) {
					reject(error);
				}
			};

			// The last backstop, and the only one that does not depend on
			// the supervisor working.
			//
			// Every other way out of here is an event from the child: it
			// exits, its pipes close, or it fails to spawn. A supervisor
			// that starts and then wedges before installing its own
			// watchdog fires none of them, and this promise never settles,
			// so a fleet run waits for ever on a reviewer that will never
			// answer. That is the failure this whole file exists to
			// prevent, and it was reachable from the outside.
			//
			// The supervisor is told how long it may take, so waiting a
			// little past that is enough: if it were alive and healthy it
			// would have stopped its own child and reported by then.
			const effectiveTimeoutMs =
				timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const graceMs = parentGraceMs(
				config.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
				config.supervisorGraceMs,
			);
			const deadline = setTimeout(() => {
				void settle(async () => {
					supervisor.kill("SIGKILL");
					const onDisk = await readResult(
						terminalResultPath ?? paths.resultPath,
					);
					if (onDisk) return fromResult(onDisk, warnings, stderrTail);
					// Everything knowable about why, gathered while the
					// evidence still exists. A run that gives up has one
					// chance to say what it saw, and "never reported" on its
					// own sent me hunting through CI logs for an afternoon.
					return {
						exitCode: 1,
						finalAssistantText: "",
						warnings: [
							...warnings,
							`Reviewer supervisor never reported within ` +
								`${effectiveTimeoutMs + graceMs}ms and was ` +
								`killed. It was given ${effectiveTimeoutMs}ms to run.`,
							await supervisorPostMortem(supervisor, paths),
						],
						stderrTail,
					};
				});
			}, effectiveTimeoutMs + graceMs);
			deadline.unref?.();
			const abortHandler = (): void => {
				void (async () => {
					// Write the cancel file first so the supervisor can stop
					// its detached child gracefully, but never let a write
					// failure skip the kill or surface as an unhandled
					// rejection: the SIGTERM below is the backstop.
					try {
						await store.requestReviewerCancellation(
							effectiveRunId,
							effectiveReviewerId,
							"parent-abort",
						);
					} catch {
						// Best-effort: the kill still stops the supervisor.
					}
					supervisor.kill("SIGTERM");
				})();
			};
			if (signal) {
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
			supervisor.stdout?.on("data", (chunk: Buffer) => {
				stdoutBuffer += chunk.toString("utf-8");
				while (true) {
					const newlineIndex = stdoutBuffer.indexOf("\n");
					if (newlineIndex < 0) return;
					const line = stdoutBuffer.slice(0, newlineIndex);
					stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
					const event = parseSupervisorLine(line, warnings);
					if (!event) continue;
					if (
						event.type === "terminal" &&
						typeof event.resultPath === "string"
					) {
						terminalResultPath = event.resultPath;
						// The run is over by the supervisor's own account, and
						// it writes the result file before saying so, so there
						// is nothing left to wait for.
						//
						// Waiting for the process to exit instead made the
						// answer depend on the operating system telling us
						// about a process, when the contract was always a file.
						// Every hang this file has had came through that gap:
						// stdio held open by something the child started, an
						// exit notification that never arrived under CI load. A
						// supervisor that has finished and then wedges no
						// longer costs the caller anything.
						void settleFromTerminal(event.resultPath);
					}
					try {
						onEvent?.(event as unknown as Record<string, unknown>);
					} catch {
						// Progress observers are best-effort and must not fail the run.
					}
				}
			});
			supervisor.stderr?.on("data", (chunk: Buffer) => {
				stderrTail = tail(
					`${stderrTail}${chunk.toString("utf-8")}`,
					DEFAULT_STDERR_TAIL_BYTES,
				);
			});
			supervisor.once("error", (error) => {
				void settle(async () => {
					throw error;
				});
			});

			// Settling on the terminal event leaves the process to finish
			// on its own, which it does: it exits immediately after
			// emitting. This is only for the case where it does not, so a
			// wedged supervisor cannot be left behind for ever. Unref'd,
			// because nothing should stay alive waiting to do it.
			function reapAfterTerminal(): void {
				const reap = setTimeout(() => {
					if (supervisor.exitCode === null && supervisor.signalCode === null) {
						supervisor.kill("SIGKILL");
					}
				}, graceMs);
				reap.unref?.();
			}

			async function settleFromTerminal(resultPath: string): Promise<void> {
				// Read before settling, not inside it. A settle that throws
				// rejects the caller's promise, so a terminal event with an
				// unreadable file would turn a run that merely needs the exit
				// path into a failed one.
				const onDisk = await readResult(resultPath);
				if (!onDisk) return;
				await settle(async () => fromResult(onDisk, warnings, stderrTail));
				reapAfterTerminal();
			}
			// "close" waits for the process to exit AND for its stdio to
			// close, and those are not the same event: anything that
			// inherited the supervisor's pipes and outlived it holds
			// them open, and the promise then never settles. That is a
			// hang, not a slow run, which is why this file went flaky
			// only under load and only in CI, taking the whole 60s test
			// budget on a case that finishes in 65ms alone.
			//
			// So the exit is a backstop for the close. Once the process
			// is gone the pipes get a short grace to flush, and then the
			// run is read from disk regardless. "close" still wins the
			// race in the normal case and nothing changes for it.
			supervisor.once("exit", (code) => {
				const grace = setTimeout(() => {
					void settle(async () => {
						const onDisk = await readResult(
							terminalResultPath ?? paths.resultPath,
						);
						if (onDisk) return fromResult(onDisk, warnings, stderrTail);
						return {
							exitCode: code ?? 1,
							finalAssistantText: "",
							warnings: [
								...warnings,
								"Reviewer supervisor exited but its output stayed " +
									"open; something it started is still holding the " +
									"pipes.",
							],
							stderrTail,
						};
					});
				}, STDIO_GRACE_MS);
				grace.unref?.();
			});
			supervisor.once("close", (code) => {
				void settle(async () => {
					const resultPath = terminalResultPath ?? paths.resultPath;
					const result = await readResult(resultPath);
					if (result) return fromResult(result, warnings, stderrTail);
					return {
						exitCode: code ?? 1,
						finalAssistantText: "",
						warnings: [
							...warnings,
							"Reviewer supervisor exited without a terminal result.",
						],
						stderrTail,
					};
				});
			});
		});
	};
}

/**
 * What can still be told about a supervisor that never reported.
 *
 * Read from disk and from the process rather than guessed, because
 * the guesses are all plausible and only one of them is true: a
 * process that never started looks nothing like one that ran and
 * died, and both look like silence from here. The supervisor keeps
 * a lease and a progress file precisely so its state outlives it.
 */
/**
 * How long ago a file was last written, in milliseconds.
 *
 * Clamped at zero because a clock that moved between the write and
 * the read should not report a negative age, which reads as a file
 * written in the future and sends the reader after the wrong thing.
 */
async function ageOf(path: string): Promise<number> {
	try {
		const { mtimeMs } = await stat(path);
		return Math.max(0, Math.round(Date.now() - mtimeMs));
	} catch {
		// The file was readable a moment ago, so this is a race with
		// cleanup rather than a real answer. Nothing is claimed.
		return 0;
	}
}

/**
 * How long the parent waits past the supervisor's own budget.
 *
 * The ladder only works if every rung below this one has room: the
 * supervisor is supposed to give up first and say which watchdog
 * fired, and the parent's backstop is for a supervisor that cannot
 * speak at all. A flat grace breaks that quietly, because the
 * supervisor's shutdown is not instant. After its watchdog fires it
 * still signals the child, waits out the kill grace, escalates,
 * drains the pipes, and only then writes its result.
 *
 * Measured against a real failure: with a five second kill grace and
 * a two second stdio grace, a ten second parent grace left three
 * seconds for all of that writing. It held on an idle machine and
 * lost about one CI run in five, which is the shape of a margin that
 * is technically ordered and practically absent.
 *
 * An explicit value is honoured exactly, including a very short one.
 * The tests that exercise the backstop itself need it to fire
 * promptly, and a caller naming a number has said what they want.
 * The derivation is for the default, which is what production runs
 * on and what the failure above happened under.
 */
export function parentGraceMs(
	killGraceMs: number,
	configured?: number,
): number {
	if (configured !== undefined) return configured;
	return Math.max(
		SUPERVISOR_GRACE_MS,
		killGraceMs + STDIO_GRACE_MS + FINISH_WRITE_MARGIN_MS,
	);
}

async function supervisorPostMortem(
	supervisor: ChildProcess,
	paths: ReviewerRunPaths,
): Promise<string> {
	// Neither field is set until the process is gone, so both being
	// null is how "still running" is spelled.
	const running =
		supervisor.exitCode === null && supervisor.signalCode === null;
	const said: string[] = [
		running
			? `pid ${supervisor.pid ?? "unknown"} was still running`
			: `already gone (exit ${supervisor.exitCode}, ` +
				`signal ${supervisor.signalCode})`,
	];
	for (const [what, path] of [
		["lease", paths.leasePath],
		["progress", paths.progressPath],
	] as const) {
		try {
			const raw = JSON.parse(await readFile(path, "utf-8")) as {
				state?: unknown;
			};
			// The age matters as much as the state, and for a while only
			// the state was reported. Both ways this fails say "running":
			// a supervisor starved of CPU is still writing, so its last
			// word is seconds old, while one that wedged early wrote once
			// and stopped, so its last word is as old as the whole wait.
			// Without the age a CI log cannot say which happened, which
			// is exactly the question an unreproducible hang turns on.
			said.push(
				`${what} says ${JSON.stringify(raw.state ?? raw)}, ` +
					`last written ${await ageOf(path)}ms ago`,
			);
		} catch {
			// Absent is the interesting answer here: no lease means the
			// supervisor never got as far as its first write.
			said.push(`no ${what} file`);
		}
	}
	return `What was found: ${said.join("; ")}.`;
}

/**
 * Turn the supervisor's durable result into the caller's, so the
 * close path and the exit backstop cannot describe one run two
 * different ways.
 */
function fromResult(
	result: NonNullable<Awaited<ReturnType<typeof readResult>>>,
	warnings: readonly string[],
	stderrTail: string,
): RunPiResult {
	return {
		exitCode: result.exitCode,
		finalAssistantText: result.finalAssistantText,
		...(result.state ? { state: result.state } : {}),
		...(result.usage ? { usage: result.usage } : {}),
		warnings: [...warnings, ...(result.warnings ?? [])],
		stderrTail: result.stderrTail ?? stderrTail,
		...(result.verification ? { verification: result.verification } : {}),
		...(result.error ? { error: result.error } : {}),
		...(result.artifacts ? { artifacts: result.artifacts } : {}),
	};
}

function buildRequest(
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
	},
	overrides: {
		readonly timeoutMs?: number;
		readonly idleTimeoutMs?: number;
	} = {},
): unknown {
	return {
		schemaVersion: 1,
		...input,
		parentPid: process.pid,
		paths,
		runCancelPath,
		timeoutMs: overrides.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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

function parseSupervisorLine(
	line: string,
	warnings: string[],
): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		warnings.push(
			`Malformed supervisor protocol line: ${truncate(trimmed, 80)}`,
		);
		return null;
	}
}

async function readResult(path: string): Promise<SupervisorResultFile | null> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as SupervisorResultFile;
	} catch {
		return null;
	}
}

function tail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let start = text.length - 1;
	while (start > 0) {
		const candidate = text.slice(start);
		if (Buffer.byteLength(candidate) > maxBytes) return text.slice(start + 1);
		start--;
	}
	return text;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}...`;
}

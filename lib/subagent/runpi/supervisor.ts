/**
 * The durable runner that waits: it tells a supervisor what to run,
 * listens to it, and settles on its result file, with backstops for a
 * supervisor that wedges, hangs its pipes or never reports.
 *
 * What a supervisor is told lives in `supervisor-request.ts`, what it
 * said in `supervisor-result.ts`, and the runner that walks away in
 * `supervisor-detached.ts`. Their public names are said here too, so
 * importers read every runner from one place.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ReviewerArtifactsStore } from "../artifacts.ts";
import type { RunPi, RunPiResult } from "../subagent.ts";
// The same grace the supervisor gives its reviewer, read from the
// same place. This is one hazard a level apart, and holding the
// measurement twice is how the two came to disagree.
import { fromScript } from "./fresh.ts";
// biome-ignore lint/correctness/useImportExtensions: Biome reads the .d.mts beside this .mjs as the module and asks for .mjs.mts, a file that doesn't exist.
import { STDIO_GRACE_MS } from "./grace.mjs";
import {
	DEFAULT_KILL_GRACE_MS,
	DEFAULT_STDERR_TAIL_BYTES,
	DEFAULT_TIMEOUT_MS,
	type SupervisorRunPiConfig,
	type SupervisorSpawnFn,
	supervisorEnvironment,
	told,
} from "./supervisor-request.ts";
import {
	fromResult,
	groupOf,
	parseSupervisorLine,
	readResult,
	supervisorPostMortem,
	tail,
} from "./supervisor-result.ts";

export {
	createSupervisorStartPi,
	type StartedPi,
	type StartPi,
} from "./supervisor-detached.ts";
export {
	type SupervisorRunPiConfig,
	type SupervisorSpawnFn,
	withSessionPersistence,
} from "./supervisor-request.ts";

/**
 * The grace, checked once where it enters TypeScript.
 *
 * A reload cannot refresh a script module, so this can arrive as
 * `undefined` in a session that reloaded after it was added, and this
 * is the value where that would be silent: `setTimeout` reads
 * `undefined` as fire immediately, so the drain would become no drain
 * and the answer it exists to save would go missing with no warning
 * anywhere.
 */
const drainMs = fromScript(
	STDIO_GRACE_MS,
	"STDIO_GRACE_MS",
	"lib/subagent/runpi/grace.mjs",
);

/**
 * How long past its own deadline a supervisor gets before the
 * parent stops waiting.
 *
 * Room for a slow start and a final write on a loaded machine,
 * without turning a wedged run into an unbounded one.
 */
const SUPERVISOR_GRACE_MS = 10_000;

/** What the supervisor reports for a cancelled run: 128 plus SIGINT. */
const CANCELLED_EXIT_CODE = 130;

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

/** Build a `RunPi` backed by durable reviewer supervisor jobs. */
export function createSupervisorRunPi(config: SupervisorRunPiConfig): RunPi {
	const spawnFn = config.spawn ?? (nodeSpawn as SupervisorSpawnFn);
	const store = new ReviewerArtifactsStore(config.stateDir);
	const supervisorPath =
		config.supervisorPath ??
		fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
	const nodeBinary = config.nodeBinary ?? process.execPath;

	return async function runPi(options) {
		const { cwd, signal, onEvent } = options;
		const {
			paths,
			runId: effectiveRunId,
			reviewerId: effectiveReviewerId,
		} = await told(config, options, false);
		const env = await supervisorEnvironment(config, options.env);

		return new Promise<RunPiResult>((resolve, reject) => {
			const supervisor = spawnFn(
				nodeBinary,
				[supervisorPath, paths.requestPath],
				{
					cwd,
					env,
					detached: false,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let settled = false;
			let stdoutBuffer = "";
			let stderrTail = "";
			let terminalResultPath: string | null = null;
			// The reviewer's process group, as the supervisor announced it,
			// so a supervisor that has to be killed does not take the only
			// way of stopping its reviewer with it.
			let reviewerGroup: number | null = null;
			let stopDeadline: ReturnType<typeof setTimeout> | undefined;
			const warnings: string[] = [];
			const settle = async (fn: () => Promise<RunPiResult>): Promise<void> => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				clearTimeout(stopDeadline);
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
				options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
							"Reviewer supervisor never reported within " +
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
					// Asking is not enough on its own. Until this, only the
					// supervisor's answer or the run's own deadline, most of an
					// hour away, could end the wait, so a supervisor too wedged to
					// act held the person who cancelled for that hour. It gets the
					// same room it has after any watchdog of its own: stop the
					// reviewer, escalate, drain and write.
					stopDeadline = setTimeout(() => {
						void settle(async () => {
							supervisor.kill("SIGKILL");
							stopReviewerGroup();
							const onDisk = await readResult(
								terminalResultPath ?? paths.resultPath,
							);
							if (onDisk) return fromResult(onDisk, warnings, stderrTail);
							return {
								exitCode: CANCELLED_EXIT_CODE,
								finalAssistantText: "",
								warnings: [
									...warnings,
									`Reviewer supervisor did not stop within ${graceMs}ms ` +
										"of being cancelled and was killed, with its reviewer.",
									await supervisorPostMortem(supervisor, paths),
								],
								stderrTail,
							};
						});
					}, graceMs);
					stopDeadline.unref?.();
				})();
			};
			function stopReviewerGroup(): void {
				if (reviewerGroup === null) return;
				try {
					process.kill(-reviewerGroup, "SIGKILL");
				} catch {
					// ESRCH: the group had already gone, which is what we wanted.
				}
			}
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
					if (event.type === "started") reviewerGroup = groupOf(event);
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
				}, drainMs);
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
		killGraceMs + drainMs + FINISH_WRITE_MARGIN_MS,
	);
}

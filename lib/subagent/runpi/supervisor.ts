import {
	type ChildProcess,
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ReviewerArtifactsStore, type ReviewerRunPaths } from "../artifacts.js";
import type { RunPi, RunPiResult } from "../subagent.js";

/** Subset of `child_process.spawn`'s signature we depend on. */
export type SupervisorSpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

/** Configuration for supervised reviewer subprocesses. */
export interface SupervisorRunPiConfig {
	readonly binary: string;
	readonly stateDir: string;
	readonly nodeBinary?: string;
	readonly supervisorPath?: string;
	readonly spawn?: SupervisorSpawnFn;
	readonly timeoutMs?: number;
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
	readonly exitCode: number;
	readonly finalAssistantText: string;
	readonly usage?: RunPiResult["usage"];
	readonly warnings?: readonly string[];
	readonly stderrTail?: string;
	readonly verification?: RunPiResult["verification"];
	readonly artifacts?: RunPiResult["artifacts"];
}

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5 * 1000;
const DEFAULT_MAX_EVENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_EVENT_ROTATIONS = 3;
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_ROTATIONS = 3;
const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ASSISTANT_TEXT_BYTES = 512 * 1024;
const DEFAULT_MAX_WARNINGS = 20;

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
				binary: config.binary,
				args,
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
				signal?.removeEventListener("abort", abortHandler);
				try {
					resolve(await fn());
				} catch (error) {
					reject(error);
				}
			};
			const abortHandler = (): void => {
				void (async () => {
					await store.requestReviewerCancellation(
						effectiveRunId,
						effectiveReviewerId,
						"parent-abort",
					);
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
			supervisor.once("close", (code) => {
				void settle(async () => {
					const resultPath = terminalResultPath ?? paths.resultPath;
					const result = await readResult(resultPath);
					if (result) {
						return {
							exitCode: result.exitCode,
							finalAssistantText: result.finalAssistantText,
							...(result.usage ? { usage: result.usage } : {}),
							warnings: [...warnings, ...(result.warnings ?? [])],
							stderrTail: result.stderrTail ?? stderrTail,
							...(result.verification
								? { verification: result.verification }
								: {}),
							...(result.artifacts ? { artifacts: result.artifacts } : {}),
						};
					}
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

function buildRequest(
	config: SupervisorRunPiConfig,
	paths: ReviewerRunPaths,
	runCancelPath: string,
	input: {
		readonly runId: string;
		readonly reviewerId: string;
		readonly binary: string;
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

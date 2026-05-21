/**
 * Production `RunPi` implementation that spawns a child
 * pi process via `node:child_process`.
 *
 * The reviewer dispatcher (`reviewer.ts`) speaks a thin
 * `RunPi` interface: given args + cwd, return stdout +
 * stderr + exitCode. This module is the only place that
 * touches `child_process`; everything above it is unit-
 * testable with an injected fake.
 */

import {
	type ChildProcess,
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import type { RunPi } from "./reviewer.js";

/** Subset of `child_process.spawn`'s signature we depend on. */
export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

/** Configuration for the spawn-backed `RunPi`. */
export interface SpawnRunPiConfig {
	/** Path or PATH name of the pi binary. */
	readonly binary: string;
	/** Spawn function. Inject a fake for unit tests. */
	readonly spawn?: SpawnFn;
	/** Hard wall-clock limit for one subagent run. */
	readonly timeoutMs?: number;
	/** Delay between SIGTERM and SIGKILL when stopping a stuck child. */
	readonly killGraceMs?: number;
}

/** Default wall-clock timeout for one reviewer subagent. */
export const DEFAULT_RUN_PI_TIMEOUT_MS = 20 * 60 * 1000;

/** Default grace period before escalating a stuck subprocess to SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 5 * 1000;

/**
 * Build a `RunPi` that spawns the pi binary as a child
 * process and accumulates its stdout/stderr to completion.
 */
export function createSpawnRunPi(config: SpawnRunPiConfig): RunPi {
	const spawnFn = config.spawn ?? (nodeSpawn as SpawnFn);
	const timeoutMs = config.timeoutMs ?? DEFAULT_RUN_PI_TIMEOUT_MS;
	const killGraceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

	return async function runPi({ args, cwd, signal, onEvent }) {
		return new Promise<{
			stdout: string;
			stderr: string;
			exitCode: number;
		}>((resolve, reject) => {
			const child = spawnFn(config.binary, args, {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			// Line buffer for the streaming hook. Pi emits one
			// JSON event per line on stdout, so the cheapest
			// reliable parser is: accumulate until newline,
			// JSON.parse, fire the callback, repeat. Errors
			// inside the callback are swallowed so a broken
			// observer never kills the subprocess.
			let stdoutLineBuffer = "";
			const deliverEvent = (line: string): void => {
				if (!onEvent) return;
				const trimmed = line.trim();
				if (!trimmed) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(trimmed);
				} catch {
					// Skip malformed lines silently; the
					// downstream parser in reviewer.ts records
					// a warning when it re-parses the full
					// stdout buffer.
					return;
				}
				if (typeof parsed !== "object" || parsed === null) return;
				try {
					onEvent(parsed as Record<string, unknown>);
				} catch {
					// Observer errors are best-effort; they
					// must never escape the runner.
				}
			};
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutChunks.push(chunk);
				if (!onEvent) return;
				stdoutLineBuffer += chunk.toString("utf-8");
				while (true) {
					const newlineIndex = stdoutLineBuffer.indexOf("\n");
					if (newlineIndex < 0) break;
					const line = stdoutLineBuffer.slice(0, newlineIndex);
					stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
					deliverEvent(line);
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrChunks.push(chunk);
			});

			let settled = false;
			let timedOut = false;
			let killTimer: NodeJS.Timeout | null = null;
			const clearKillTimer = (): void => {
				if (killTimer) clearTimeout(killTimer);
				killTimer = null;
			};
			const stopChild = (reason: "abort" | "timeout"): void => {
				if (reason === "timeout" && !timedOut) {
					timedOut = true;
					stderrChunks.unshift(
						Buffer.from(
							`Pi subprocess timed out after ${timeoutMs}ms; sent SIGTERM.\n`,
						),
					);
				}
				terminateProcessTree(child, "SIGTERM");
				clearKillTimer();
				killTimer = setTimeout(() => {
					terminateProcessTree(child, "SIGKILL");
				}, killGraceMs);
				killTimer.unref?.();
			};
			const abortHandler = () => stopChild("abort");
			const timeoutTimer = setTimeout(() => stopChild("timeout"), timeoutMs);
			timeoutTimer.unref?.();
			if (signal) {
				if (signal.aborted) {
					abortHandler();
				} else {
					signal.addEventListener("abort", abortHandler, { once: true });
				}
			}

			child.once("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutTimer);
				clearKillTimer();
				signal?.removeEventListener("abort", abortHandler);
				reject(err);
			});

			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutTimer);
				clearKillTimer();
				signal?.removeEventListener("abort", abortHandler);
				// Flush any tail content that arrived without a
				// trailing newline (pi normally terminates each
				// event with `\n` but defensive code is cheap).
				if (stdoutLineBuffer.length > 0) {
					deliverEvent(stdoutLineBuffer);
					stdoutLineBuffer = "";
				}
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					exitCode: code ?? 0,
				});
			});
		});
	};
}

function terminateProcessTree(
	child: ChildProcess,
	signal: NodeJS.Signals,
): void {
	if (child.pid && process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall back to killing the direct child below. This
			// can happen in tests or if the process already exited.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// Ignore: child may have already exited.
	}
}

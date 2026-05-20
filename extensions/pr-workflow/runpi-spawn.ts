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
}

/**
 * Build a `RunPi` that spawns the pi binary as a child
 * process and accumulates its stdout/stderr to completion.
 */
export function createSpawnRunPi(config: SpawnRunPiConfig): RunPi {
	const spawnFn = config.spawn ?? (nodeSpawn as SpawnFn);

	return async function runPi({ args, cwd, signal, onEvent }) {
		return new Promise<{
			stdout: string;
			stderr: string;
			exitCode: number;
		}>((resolve, reject) => {
			const child = spawnFn(config.binary, args, {
				cwd,
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
			const abortHandler = () => {
				try {
					child.kill("SIGTERM");
				} catch {
					// Ignore: child may have already exited.
				}
			};
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
				signal?.removeEventListener("abort", abortHandler);
				reject(err);
			});

			child.on("close", (code) => {
				if (settled) return;
				settled = true;
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

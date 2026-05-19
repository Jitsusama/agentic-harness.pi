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

	return async function runPi({ args, cwd, signal }) {
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
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutChunks.push(chunk);
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
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					exitCode: code ?? 0,
				});
			});
		});
	};
}

import { describe, expect, it } from "vitest";
import { createSpawnRunPi } from "../../../extensions/pr-workflow/runpi-spawn.js";

/**
 * `createSpawnRunPi` wraps `node:child_process.spawn` into
 * a `RunPi` the reviewer dispatcher can call. The unit
 * tests do not actually invoke pi; instead they inject a
 * fake spawn so we can assert command, args, cwd and
 * stream handling without needing a working pi binary in
 * the test environment.
 */

import type { Readable, Writable } from "node:stream";
import { PassThrough } from "node:stream";

interface FakeChild {
	stdout: Readable;
	stderr: Readable;
	stdin?: Writable;
	on(event: "close", listener: (code: number | null) => void): FakeChild;
	once(event: "error", listener: (err: Error) => void): FakeChild;
	kill(signal?: NodeJS.Signals): boolean;
}

function makeFakeChild(): {
	child: FakeChild;
	emitClose: (code: number) => void;
	emitError: (err: Error) => void;
	stdout: PassThrough;
	stderr: PassThrough;
} {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const handlers: {
		close: ((code: number | null) => void)[];
		error: ((err: Error) => void)[];
	} = { close: [], error: [] };
	const child: FakeChild = {
		stdout,
		stderr,
		on(event, listener) {
			if (event === "close") {
				handlers.close.push(listener);
			}
			return child;
		},
		once(event, listener) {
			if (event === "error") {
				handlers.error.push(listener);
			}
			return child;
		},
		kill: () => true,
	};
	return {
		child,
		emitClose: (code) => {
			for (const h of handlers.close) h(code);
		},
		emitError: (err) => {
			for (const h of handlers.error) h(err);
		},
		stdout,
		stderr,
	};
}

describe("createSpawnRunPi", () => {
	it("invokes the provided spawn with the pi binary and the supplied args/cwd", async () => {
		const fake = makeFakeChild();
		const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
		const runPi = createSpawnRunPi({
			binary: "pi",
			spawn: (command, args, opts) => {
				calls.push({ command, args, cwd: String(opts?.cwd ?? "") });
				queueMicrotask(() => {
					fake.stdout.end("");
					fake.stderr.end("");
					fake.emitClose(0);
				});
				return fake.child as unknown as ReturnType<typeof spawnStub>;
			},
		});
		await runPi({
			args: ["--mode", "json", "--no-session", "-p", "prompt"],
			cwd: "/tmp/wt",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("pi");
		expect(calls[0].args).toEqual([
			"--mode",
			"json",
			"--no-session",
			"-p",
			"prompt",
		]);
		expect(calls[0].cwd).toBe("/tmp/wt");
	});

	it("collects stdout, stderr and exit code into the RunPiResult", async () => {
		const fake = makeFakeChild();
		const runPi = createSpawnRunPi({
			binary: "pi",
			spawn: () => {
				queueMicrotask(() => {
					fake.stdout.write("line 1\n");
					fake.stdout.end("line 2\n");
					fake.stderr.end("oops");
					fake.emitClose(2);
				});
				return fake.child as unknown as ReturnType<typeof spawnStub>;
			},
		});
		const result = await runPi({ args: [], cwd: "/tmp" });
		expect(result.stdout).toBe("line 1\nline 2\n");
		expect(result.stderr).toBe("oops");
		expect(result.exitCode).toBe(2);
	});

	it("rejects when the spawn emits an error before close", async () => {
		// If pi isn't on PATH, ENOENT shows up on `error`.
		// We surface that as a rejection so the dispatcher
		// can treat it the same as any other crash.
		const fake = makeFakeChild();
		const runPi = createSpawnRunPi({
			binary: "missing-pi",
			spawn: () => {
				queueMicrotask(() => {
					fake.emitError(new Error("ENOENT: missing-pi"));
				});
				return fake.child as unknown as ReturnType<typeof spawnStub>;
			},
		});
		await expect(runPi({ args: [], cwd: "/tmp" })).rejects.toThrow(/ENOENT/);
	});

	it("propagates AbortSignal cancellation by killing the child", async () => {
		// The orchestrator wires its run-level AbortSignal
		// down to each reviewer. When the user cancels the
		// council, every in-flight subprocess gets a
		// SIGTERM rather than continuing to burn tokens.
		const fake = makeFakeChild();
		let killed = false;
		fake.child.kill = () => {
			killed = true;
			queueMicrotask(() => fake.emitClose(143));
			return true;
		};
		const runPi = createSpawnRunPi({
			binary: "pi",
			spawn: () => fake.child as unknown as ReturnType<typeof spawnStub>,
		});
		const ac = new AbortController();
		const promise = runPi({ args: [], cwd: "/tmp", signal: ac.signal });
		ac.abort();
		const result = await promise;
		expect(killed).toBe(true);
		expect(result.exitCode).toBe(143);
	});
});

// Just to give the test file the same shape Node's `spawn`
// returns so the cast above stays honest. We don't import
// from `child_process` to keep the test self-contained.
declare function spawnStub(): FakeChild;

import type { SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	pinChildEnvironment,
	unpinChildEnvironment,
} from "../../../../lib/subagent/child-env.ts";
import {
	createSpawnRunPi,
	type SpawnFn,
} from "../../../../lib/subagent/runpi/spawn.ts";
import { at } from "../../../support/at.ts";
import { makeFakeChild } from "./fake-child.ts";

/**
 * `createSpawnRunPi` wraps `node:child_process.spawn` into
 * a `RunPi` the reviewer dispatcher can call. The unit
 * tests do not actually invoke pi; instead they inject a
 * fake spawn so we can assert command, args, cwd and
 * stream handling without needing a working pi binary in
 * the test environment.
 */

/** The pinned install most tests launch. */
const INSTALL = {
	node: "/nix/store/node-22/bin/node",
	entry: "/nix/store/pi/dist/cli.js",
};

/** The immutable package dir a Nix install pins. */
const PACKAGE_DIR = "/nix/store/pi-0.80.7/lib/node_modules/pi-monorepo";

/** One call the runner made to spawn. */
interface SpawnCall {
	readonly command: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
}

/**
 * A spawn whose child writes each stdout chunk and its stderr, then
 * closes with the code, keeping every call it was given.
 */
function finishingSpawn(
	output: {
		readonly stdout?: readonly string[];
		readonly stderr?: string;
		readonly code?: number;
	} = {},
): { spawn: SpawnFn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const spawn: SpawnFn = (command, args, options) => {
		calls.push({ command, args, options });
		const fake = makeFakeChild();
		queueMicrotask(() => {
			for (const chunk of output.stdout ?? []) fake.stdout.write(chunk);
			fake.stdout.end();
			fake.stderr.end(output.stderr ?? "");
			fake.emitClose(output.code ?? 0);
		});
		return fake.process();
	};
	return { spawn, calls };
}

/** A spawn whose child runs until it is killed, then closes with the code. */
function killedSpawn(code: number | null): {
	spawn: SpawnFn;
	kills: Array<NodeJS.Signals | undefined>;
} {
	const fake = makeFakeChild();
	fake.child.kill = (signal) => {
		fake.kills.push(signal);
		queueMicrotask(() => fake.emitClose(code));
		return true;
	};
	return { spawn: () => fake.process(), kills: fake.kills };
}

describe("createSpawnRunPi", () => {
	it("invokes the provided spawn as the install's node running its entry, then the args", async () => {
		const { spawn, calls } = finishingSpawn();
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		await runPi({
			args: ["--mode", "json", "--no-session", "-p", "prompt"],
			cwd: "/tmp/wt",
		});
		expect(calls).toHaveLength(1);
		expect(at(calls, 0).command).toBe("/nix/store/node-22/bin/node");
		expect(at(calls, 0).args).toEqual([
			"/nix/store/pi/dist/cli.js",
			"--mode",
			"json",
			"--no-session",
			"-p",
			"prompt",
		]);
		expect(at(calls, 0).options.cwd).toBe("/tmp/wt");
		expect(calls[0]).toMatchObject({ options: { detached: true } });
	});

	it("overrides the child's PI_PACKAGE_DIR with the pinned package dir", async () => {
		// A mid-session upgrade deletes the versioned symlink the
		// inherited PI_PACKAGE_DIR names, so the child must be told
		// the immutable store path the parent captured at startup.
		const { spawn, calls } = finishingSpawn();
		const runPi = createSpawnRunPi({
			piInstall: { ...INSTALL, packageDir: PACKAGE_DIR },
			spawn,
		});
		await runPi({ args: [], cwd: "/tmp" });
		expect(calls[0]?.options.env?.PI_PACKAGE_DIR).toBe(PACKAGE_DIR);
	});

	it("gives the child the run's own variables on top of the pinned package dir", async () => {
		const { spawn, calls } = finishingSpawn();
		const runPi = createSpawnRunPi({
			piInstall: { ...INSTALL, packageDir: PACKAGE_DIR },
			spawn,
		});
		await runPi({ args: [], cwd: "/tmp", env: { PI_SANDBOX: "strict" } });
		const env = calls[0]?.options.env;
		expect(env?.PI_SANDBOX).toBe("strict");
		expect(env?.PI_PACKAGE_DIR).toBe(PACKAGE_DIR);
	});

	it("gives the child what the process pinned, under the run's own variables", async () => {
		// A host holds no gateway key in its own environment, so it pins
		// one for its children; the run's own variables still win.
		const { spawn, calls } = finishingSpawn();
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		pinChildEnvironment(async () => ({
			SHOPIFY_PROXY_KEY: "host-key",
			PI_SANDBOX: "pinned",
		}));
		try {
			await runPi({ args: [], cwd: "/tmp", env: { PI_SANDBOX: "strict" } });
		} finally {
			unpinChildEnvironment();
		}
		const env = calls[0]?.options.env;
		expect(env?.SHOPIFY_PROXY_KEY).toBe("host-key");
		expect(env?.PI_SANDBOX).toBe("strict");
	});

	it("starts the child of a session set off without off, so the stage fences it", async () => {
		// Off is one session's way back (ISXEG8 [8599528b]), not its children's.
		const { spawn, calls } = finishingSpawn();
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		vi.stubEnv("PI_SANDBOX", "off");
		try {
			await runPi({ args: [], cwd: "/tmp" });
		} finally {
			vi.unstubAllEnvs();
		}
		const env = calls[0]?.options.env;
		expect(env, "the child is given an environment").toBeDefined();
		expect(env?.PI_SANDBOX, "and no PI_SANDBOX=off in it").toBeUndefined();
		expect(env?.PATH, "but the rest of the session's").toBe(process.env.PATH);
	});

	it("leaves the child env untouched when no package dir was captured", async () => {
		// Plain npm/brew installs self-locate from the entry
		// script and set no PI_PACKAGE_DIR, so the spawn must not
		// invent one.
		const { spawn, calls } = finishingSpawn();
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		await runPi({ args: [], cwd: "/tmp" });
		// No env override object is passed, so the child inherits
		// the parent environment unchanged.
		expect(
			calls[0]?.options.env,
			"no env override is passed to the child",
		).toBeUndefined();
	});

	it("collects stdout, stderr and exit code into the RunPiResult", async () => {
		const { spawn } = finishingSpawn({
			stdout: ["line 1\n", "line 2\n"],
			stderr: "oops",
			code: 2,
		});
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
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
			piInstall: {
				node: "/nix/store/missing/bin/node",
				entry: "/nix/store/missing/dist/cli.js",
			},
			spawn: () => {
				queueMicrotask(() => {
					fake.emitError(new Error("ENOENT: missing-pi"));
				});
				return fake.process();
			},
		});
		await expect(runPi({ args: [], cwd: "/tmp" })).rejects.toThrow(/ENOENT/);
	});

	it("streams each JSON event line to onEvent as it arrives", async () => {
		const events: Record<string, unknown>[] = [];
		const { spawn } = finishingSpawn({
			stdout: [
				'{"type":"agent_start"}\n',
				'{"type":"tool_execution_start","toolName":"read","args":{"path":"task.go"}}\n',
				'{"type":"agent_end"}\n',
			],
		});
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		await runPi({
			args: [],
			cwd: "/tmp",
			onEvent: (event) => events.push(event),
		});
		expect(events).toHaveLength(3);
		expect(events[0]?.type).toBe("agent_start");
		expect(events[1]?.type).toBe("tool_execution_start");
		expect(events[2]?.type).toBe("agent_end");
	});

	it("reassembles events split across multiple data chunks", async () => {
		const events: Record<string, unknown>[] = [];
		const { spawn } = finishingSpawn({
			stdout: [
				'{"type":"tool_execu',
				'tion_start","toolName":"read"',
				',"args":{}}\n',
			],
		});
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		await runPi({
			args: [],
			cwd: "/tmp",
			onEvent: (event) => events.push(event),
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "tool_execution_start",
			toolName: "read",
		});
	});

	it("skips malformed lines without throwing", async () => {
		const events: Record<string, unknown>[] = [];
		const { spawn } = finishingSpawn({
			stdout: ["not json at all\n", '{"type":"agent_end"}\n'],
		});
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		const result = await runPi({
			args: [],
			cwd: "/tmp",
			onEvent: (event) => events.push(event),
		});
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("agent_end");
		// Both lines still land in the final stdout buffer
		// so downstream parsers see them.
		expect(result.stdout).toContain("not json at all");
	});

	it("swallows observer errors so a broken callback can't kill the run", async () => {
		const { spawn } = finishingSpawn({ stdout: ['{"type":"agent_end"}\n'] });
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		const result = await runPi({
			args: [],
			cwd: "/tmp",
			onEvent: () => {
				throw new Error("observer broke");
			},
		});
		expect(result.exitCode).toBe(0);
	});

	it("times out a stuck subprocess and surfaces the timeout in stderr", async () => {
		const { spawn, kills } = killedSpawn(143);
		const runPi = createSpawnRunPi({
			piInstall: INSTALL,
			spawn,
			timeoutMs: 1,
			killGraceMs: 50,
		});

		const result = await runPi({ args: [], cwd: "/tmp" });

		expect(kills).toContain("SIGTERM");
		expect(result.exitCode).toBe(143);
		expect(result.stderr).toContain("timed out after 1ms");
	});

	it("propagates AbortSignal cancellation by killing the child", async () => {
		// The orchestrator wires its run-level AbortSignal
		// down to each reviewer. When the user cancels the
		// council, every in-flight subprocess gets a
		// SIGTERM rather than continuing to burn tokens.
		const { spawn, kills } = killedSpawn(143);
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		const ac = new AbortController();
		const promise = runPi({ args: [], cwd: "/tmp", signal: ac.signal });
		ac.abort();
		const result = await promise;
		expect(kills.length, "aborting the run kills the child").toBeGreaterThan(0);
		expect(result.exitCode).toBe(143);
		expect(result.stderr).toContain("cancelled");
	});

	it("prefers per-call timeoutMs over the constructor default", async () => {
		// The spawn-backed runner is non-supervising, so the
		// only knob it honours is the wall-clock cap. A
		// per-call value must override the constructor's
		// configured default; otherwise the fleet tool's
		// per-job override would silently no-op for any
		// caller still on the spawn runner.
		const { spawn, kills } = killedSpawn(143);
		const runPi = createSpawnRunPi({
			piInstall: INSTALL,
			spawn,
			timeoutMs: 60_000,
			killGraceMs: 50,
		});

		const result = await runPi({ args: [], cwd: "/tmp", timeoutMs: 1 });

		expect(kills).toContain("SIGTERM");
		expect(result.exitCode).toBe(143);
		expect(result.stderr).toContain("timed out after 1ms");
	});

	it("warns when idleTimeoutMs is set on the non-supervising runner", async () => {
		// The spawn runner has no supervisor protocol and
		// therefore no idle clock. Silently dropping an
		// idle override would let a caller think they'd
		// extended the idle ceiling when in fact only the
		// wall clock applies. Surface a warning through
		// the existing warnings channel so the caller can
		// see the no-op without runtime surprise.
		const { spawn } = finishingSpawn({ stdout: ['{"type":"agent_end"}\n'] });
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });

		const result = await runPi({
			args: [],
			cwd: "/tmp",
			idleTimeoutMs: 5 * 60 * 1000,
		});

		expect(result.exitCode).toBe(0);
		expect(result.warnings ?? []).toContainEqual(
			expect.stringMatching(/idleTimeoutMs.*ignored.*wall-clock only/i),
		);
	});

	it("emits no idleTimeoutMs warning when the caller leaves it unset", async () => {
		// The warning is opt-in feedback; runs that don't
		// touch the field should land on a clean warnings
		// array (or omit the field entirely, since the
		// channel is optional).
		const { spawn } = finishingSpawn({ stdout: ['{"type":"agent_end"}\n'] });
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });

		const result = await runPi({ args: [], cwd: "/tmp" });

		const idleWarnings = (result.warnings ?? []).filter((w) =>
			/idleTimeoutMs/.test(w),
		);
		expect(idleWarnings).toHaveLength(0);
	});

	it("uses a cancellation exit code when abort closes without a code", async () => {
		const { spawn } = killedSpawn(null);
		const runPi = createSpawnRunPi({ piInstall: INSTALL, spawn });
		const ac = new AbortController();
		const promise = runPi({ args: [], cwd: "/tmp", signal: ac.signal });
		ac.abort();
		const result = await promise;
		expect(result.exitCode).toBe(130);
		expect(result.stderr).toContain("cancelled");
	});
});

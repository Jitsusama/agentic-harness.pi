/**
 * The environment a supervised child is started in: the pinned package,
 * what the session offers its commands, the run's own variables, the
 * process's pins and the cache retention its runner names.
 */

import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { offerShellEnvironment } from "../../../../lib/internal/shell/environment.ts";
import { pinChildEnvironment, unpinChildEnvironment } from "../../../../lib/subagent/child-env.ts";
import { TEST_TIMEOUT_MS, tempStateDir, GENEROUS_MS, createSupervisorRunPi, runChild, expectRan } from "./supervised.ts";

// Slack for spawning, not a work budget: TEST_TIMEOUT_MS says why.
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

describe("createSupervisorRunPi: the child's environment", () => {
	it("sets the child's PI_PACKAGE_DIR to the pinned package dir", async () => {
		// End-to-end proof of the mid-session-upgrade fix: the
		// child echoes its own PI_PACKAGE_DIR, and it must equal
		// the immutable store path the parent pinned, not whatever
		// stale value the parent's environment carried.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:String(process.env.PI_PACKAGE_DIR)}]}})+"\\n");`,
		);
		const pinned = "/nix/store/pinned-pi-0.80.7/lib/node_modules/pi-monorepo";
		const runPi = createSupervisorRunPi({
			piInstall: {
				node: process.execPath,
				entry: childPath,
				packageDir: pinned,
			},
			stateDir,
			idleTimeoutMs: GENEROUS_MS,
			timeoutMs: GENEROUS_MS,
		});

		// Set a conflicting parent value so the assertion proves the
		// override beats inheritance, not merely that the variable is
		// present. This is the deleted-symlink path the fix targets.
		const previous = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = "/Users/x/.pi/pkg/pi-0.80.7-deleted";
		let result: Awaited<ReturnType<typeof runPi>>;
		try {
			result = await runPi({
				args: [],
				cwd: stateDir,
				runId: "run",
				reviewerId: "fast",
			});
		} finally {
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}

		expectRan(result);
		expect(result.finalAssistantText).toBe(pinned);
	});

	it("gives the child what the session offers its commands, such as the quest", async () => {
		// The machine shares CPU and disk by quest, sorting each piece of
		// work by the quest its environment names. A subagent's work is
		// its session's quest's work, so the child carries it too.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:String(process.env.PI_QUEST)}]}})+"\\n");`,
		);
		const runPi = runChild(childPath, stateDir);

		offerShellEnvironment("test", () => ({ PI_QUEST: "QEST-20261024-ABC123" }));
		let result: Awaited<ReturnType<typeof runPi>>;
		try {
			result = await runPi({
				args: [],
				cwd: stateDir,
				runId: "run",
				reviewerId: "fast",
			});
		} finally {
			offerShellEnvironment("test", undefined);
		}

		expectRan(result);
		expect(result.finalAssistantText).toBe("QEST-20261024-ABC123");
	});

	it("gives the child the run's own variables, and writes none of them to disk", async () => {
		const stateDir = await tempStateDir();
		const childFolder = await mkdtemp(join(tmpdir(), "supervisor-child-"));
		const childPath = join(childFolder, "child.mjs");
		await writeFile(
			childPath,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:String(process.env.PI_SANDBOX)}]}})+"\\n");`,
		);
		const result = await runChild(
			childPath,
			stateDir,
		)({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "fenced",
			env: { PI_SANDBOX: "strict" },
		});
		expectRan(result);
		expect(result.finalAssistantText).toBe("strict");
		// A request outlives its run, and a resume reads it again, so the
		// variables live only in the process they were given to.
		const written = await readdir(stateDir, { recursive: true });
		for (const name of written) {
			const path = join(stateDir, name);
			if (!(await stat(path)).isFile()) continue;
			expect(await readFile(path, "utf8")).not.toContain("PI_SANDBOX");
		}
	});

	it("starts a subagent of a session set off without off, so the stage fences it", async () => {
		// Off is one session's way back (ISXEG8 [8599528b]): passed on, it
		// would leave every subagent of that session unfenced though listed.
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:String(process.env.PI_SANDBOX)}]}})+"\\n");`,
		);
		vi.stubEnv("PI_SANDBOX", "off");
		let result: Awaited<ReturnType<ReturnType<typeof createSupervisorRunPi>>>;
		try {
			result = await runChild(
				childPath,
				stateDir,
			)({ args: [], cwd: stateDir, runId: "run", reviewerId: "off" });
		} finally {
			vi.unstubAllEnvs();
		}
		expectRan(result);
		expect(
			result.finalAssistantText,
			"a subagent inherits no PI_SANDBOX=off",
		).toBe("undefined");
	});

	it("gives the child what the process pinned, under the run's own variables", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:process.env.SHOPIFY_PROXY_KEY+" "+process.env.PI_SANDBOX}]}})+"\\n");`,
		);
		pinChildEnvironment(async () => ({
			SHOPIFY_PROXY_KEY: "host-key",
			PI_SANDBOX: "pinned",
		}));
		try {
			const result = await runChild(
				childPath,
				stateDir,
			)({
				args: [],
				cwd: stateDir,
				runId: "run",
				reviewerId: "keyed",
				env: { PI_SANDBOX: "strict" },
			});
			expectRan(result);
			expect(result.finalAssistantText).toBe("host-key strict");
		} finally {
			unpinChildEnvironment();
		}
	});

	it("gives the child the cache retention its runner names, in place of the session's", async () => {
		const stateDir = await tempStateDir();
		const childPath = join(stateDir, "child.mjs");
		await writeFile(
			childPath,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:String(process.env.PI_CACHE_RETENTION)}]}})+"\\n");`,
		);
		const runner = (cacheRetention?: "short" | "long") =>
			runChild(childPath, stateDir, {
				...(cacheRetention === undefined ? {} : { cacheRetention }),
			});
		const previous = process.env.PI_CACHE_RETENTION;
		process.env.PI_CACHE_RETENTION = "long";
		try {
			const named = await runner("short")({
				args: [],
				cwd: stateDir,
				runId: "run",
				reviewerId: "named",
			});
			const unnamed = await runner()({
				args: [],
				cwd: stateDir,
				runId: "run",
				reviewerId: "unnamed",
			});
			expectRan(named);
			expect(named.finalAssistantText).toBe("short");
			expectRan(unnamed);
			expect(unnamed.finalAssistantText).toBe("long");
		} finally {
			if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
			else process.env.PI_CACHE_RETENTION = previous;
		}
	});
});

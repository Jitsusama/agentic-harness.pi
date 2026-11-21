/**
 * A folder's own extensions run their commands inside the session's
 * sandbox: a host's pi hands their exec to the one this package sets as
 * each session starts, which runs a command as pi's own exec does, its
 * time limit, abort and output cap held, wrapped in the sandbox.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shellWorkflow from "../../../extensions/shell-workflow/index.ts";
import {
	type ProjectExec,
	projectExecIn,
	setsProjectExec,
} from "../../../extensions/shell-workflow/project-exec.ts";
import { OFF } from "../../../lib/internal/fence/fence-stage.ts";
import {
	SANDBOX_VARIABLE,
	type Sandbox,
} from "../../../lib/internal/sandbox/sandbox.ts";

const NONE: Sandbox = { kind: "none" };

let folder: string;

beforeEach(() => {
	folder = realpathSync(mkdtempSync(join(tmpdir(), "project-exec-")));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("a folder's extension's command", () => {
	it("runs in the folder it names, with the session's environment, its words kept whole", async () => {
		const exec = projectExecIn(NONE, () => ({
			...process.env,
			GIVEN: "from the session",
		}));
		const done = await exec(
			"bash",
			["-c", 'printf "%s|%s|%s" "$PWD" "$GIVEN" "$0"', "two words"],
			folder,
		);
		expect(done).toMatchObject({
			stdout: `${folder}|from the session|two words`,
			code: 0,
			killed: false,
		});
	});

	it("says a command's own exit code and what it wrote to stderr", async () => {
		const exec = projectExecIn(NONE, () => process.env);
		const done = await exec("bash", ["-c", "echo no >&2; exit 3"], folder);
		expect(done).toMatchObject({ stderr: "no\n", code: 3 });
	});

	it("runs wrapped in the session's sandbox, as the agent's own commands do", async () => {
		const fence = { kind: "fence" } as unknown as Sandbox;
		const wrapped: string[] = [];
		const exec = projectExecIn(
			fence,
			() => process.env,
			"/home/person",
			(sandbox, place, home) => {
				expect(sandbox).toBe(fence);
				expect(place.cwd).toBe(folder);
				expect(home).toBe("/home/person");
				return (script) => {
					wrapped.push(script);
					return `echo fenced; ${script}`;
				};
			},
		);
		const done = await exec("echo", ["it's"], folder);
		expect(wrapped).toEqual(["'echo' 'it'\\''s'"]);
		expect(done.stdout).toBe("fenced\nit's\n");
	});

	it("is stopped at its time limit", async () => {
		const exec = projectExecIn(NONE, () => process.env);
		const done = await exec("sleep", ["10"], folder, { timeout: 100 });
		expect(done.killed).toBe(true);
	});

	it("is stopped when its signal aborts", async () => {
		const exec = projectExecIn(NONE, () => process.env);
		const stop = new AbortController();
		const running = exec("sleep", ["10"], folder, { signal: stop.signal });
		stop.abort();
		expect((await running).killed).toBe(true);
	});

	it("is cut off past the most output it may keep, and never says it passed", async () => {
		const exec = projectExecIn(
			NONE,
			() => process.env,
			undefined,
			undefined,
			1000,
		);
		const done = await exec("bash", ["-c", "yes | head -c 100000"], folder);
		expect(done.stdout.length).toBeLessThanOrEqual(1000);
		expect(done.stderr).toContain("said more than 1000 bytes");
		expect(done.code).not.toBe(0);
	});

	it("ends once it exits, though a program it left running holds its output open", async () => {
		const exec = projectExecIn(NONE, () => process.env);
		const started = Date.now();
		const done = await exec("bash", ["-c", "(sleep 5 &) ; echo left"], folder);
		expect(done).toMatchObject({ stdout: "left\n", code: 0 });
		expect(Date.now() - started).toBeLessThan(4000);
	});
});

describe("setting a folder's extensions' exec", () => {
	/** A pi as the extension sees it, saying what it was given. */
	function piWith(sets: boolean) {
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => Promise<void>
		>();
		const set: ProjectExec[] = [];
		const pi = {
			events: createEventBus(),
			on: (
				event: string,
				handler: (e: unknown, c: unknown) => Promise<void>,
			) => {
				handlers.set(event, handler);
			},
			registerTool: () => {},
			...(sets
				? {
						setProjectExec: (exec: ProjectExec) => {
							set.push(exec);
						},
					}
				: {}),
		} as unknown as ExtensionAPI;
		return { pi, handlers, set };
	}

	const ctx = () => ({
		mode: "print",
		cwd: folder,
		hasUI: false,
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => undefined,
		},
	});

	it("is asked of a host's pi, whose builds can take one", () => {
		expect(setsProjectExec(piWith(true).pi)).toBe(true);
		expect(setsProjectExec(piWith(false).pi)).toBe(false);
	});

	it("is set once a session starts, never while the extension loads", async () => {
		vi.stubEnv(SANDBOX_VARIABLE, OFF);
		const { pi, handlers, set } = piWith(true);
		shellWorkflow(pi);
		expect(set).toEqual([]);
		await handlers.get("session_start")?.({ type: "session_start" }, ctx());
		expect(set).toHaveLength(1);
		const done = await set[0]?.("printf", ["ran"], folder);
		expect(done?.stdout).toBe("ran");
	});

	it("is left alone on a pi that can't take one", async () => {
		vi.stubEnv(SANDBOX_VARIABLE, OFF);
		const { pi, handlers } = piWith(false);
		shellWorkflow(pi);
		await expect(
			handlers.get("session_start")?.({ type: "session_start" }, ctx()),
		).resolves.toBeUndefined();
	});
});

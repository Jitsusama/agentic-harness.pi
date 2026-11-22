/**
 * A folder's own extensions run their commands inside the session's
 * sandbox: a host's pi hands their exec to the one this package sets as
 * each session starts, which runs a command as the agent's own bash
 * does, its environment, sandbox and folder the session's, its time
 * limit, abort and output cap held over its whole process group, and
 * anything that fails before it starts answered as a refusal.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shellWorkflow from "../../../extensions/shell-workflow/index.ts";
import {
	endedProjectExec,
	type ProjectExec,
	type ProjectExecParts,
	projectExecIn,
	setsProjectExec,
} from "../../../extensions/shell-workflow/project-exec.ts";
import { OFF } from "../../../lib/internal/fence/fence-stage.ts";
import {
	SANDBOX_VARIABLE,
	type Sandbox,
} from "../../../lib/internal/sandbox/sandbox.ts";
import { SSH_GUARD_MACHINES } from "../../../lib/internal/shell/ssh-guard.ts";

const NONE: Sandbox = { kind: "none" };

let folder: string;

beforeEach(() => {
	folder = realpathSync(mkdtempSync(join(tmpdir(), "project-exec-")));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** An exec over this test's folder, as a session with no sandbox has. */
function execWith(parts: Partial<ProjectExecParts> = {}): ProjectExec {
	return projectExecIn({
		sandbox: NONE,
		environment: () => process.env,
		folder: () => folder,
		...parts,
	});
}

describe("a folder's extension's command", () => {
	it("runs in the folder it names, with the session's environment, its words kept whole", async () => {
		const exec = execWith({
			environment: () => ({ ...process.env, GIVEN: "from the session" }),
		});
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
		const done = await execWith()(
			"bash",
			["-c", "echo no >&2; exit 3"],
			folder,
		);
		expect(done).toMatchObject({ stderr: "no\n", code: 3 });
	});

	it("carries the ssh guard and asks nothing, as the agent's commands do", async () => {
		const exec = execWith({
			sshGuard: () => ({ refuse: true, machines: ["one", "two"] }),
		});
		const done = await exec(
			"bash",
			["-c", `printf "%s|%s" "$${SSH_GUARD_MACHINES}" "$GIT_TERMINAL_PROMPT"`],
			folder,
		);
		expect(done.stdout).toBe("one two|0");
	});

	it("runs wrapped in the session's sandbox, as the agent's own commands do", async () => {
		const fence = { kind: "fence" } as unknown as Sandbox;
		const wrapped: string[] = [];
		const exec = execWith({
			sandbox: fence,
			home: "/home/person",
			environment: () => ({ ...process.env, GIVEN: "from the session" }),
			wrapping: (sandbox, place, home) => {
				expect(sandbox).toBe(fence);
				expect(place.cwd).toBe(folder);
				expect(home).toBe("/home/person");
				// The fence places its scratch and session from what it's handed.
				expect(place.env.GIVEN).toBe("from the session");
				expect(place.env.GIT_TERMINAL_PROMPT).toBe("0");
				return (script) => {
					wrapped.push(script);
					return `echo fenced; ${script}`;
				};
			},
		});
		const done = await exec("echo", ["it's"], folder);
		expect(wrapped).toEqual(["'echo' 'it'\\''s'"]);
		expect(done.stdout).toBe("fenced\nit's\n");
	});

	it("is wrapped from the session's folder and moves into a folder below it inside the wrap", async () => {
		const inner = join(folder, "inner");
		mkdirSync(inner);
		const wrapped: string[] = [];
		const exec = execWith({
			sandbox: { kind: "fence" } as unknown as Sandbox,
			wrapping: (_sandbox, place) => {
				// The grants are the session folder's, whatever the folder asked:
				// one below could hold a link or a .git file a command planted.
				expect(place.cwd).toBe(folder);
				return (script) => {
					wrapped.push(script);
					return script;
				};
			},
		});
		const done = await exec("pwd", [], "inner");
		expect(wrapped).toEqual([`cd -- '${inner}' && 'pwd'`]);
		expect(done).toMatchObject({ stdout: `${inner}\n`, code: 0 });
	});

	it("is refused through a link in the session's folder to one outside it, nothing run", async () => {
		const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "elsewhere-")));
		try {
			symlinkSync(elsewhere, join(folder, "out"));
			const marker = join(elsewhere, "ran");
			const done = await execWith()("touch", ["ran"], join(folder, "out"));
			expect(done.code).toBe(126);
			expect(done.stderr).toContain("only in its session's folder");
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("is refused in a folder that isn't there", async () => {
		const done = await execWith()("true", [], join(folder, "gone"));
		expect(done.code).toBe(126);
		expect(done.stderr).toContain("a folder that is there");
	});

	it("is refused when a sandbox other than none gives no wrap, rather than run unfenced", async () => {
		const marker = join(folder, "ran");
		const done = await execWith({
			sandbox: { kind: "strict" } as unknown as Sandbox,
			wrapping: () => undefined,
		})("touch", [marker], folder);
		expect(done.code).toBe(126);
		expect(existsSync(marker)).toBe(false);
	});

	it("answers 126, nothing run, where the real wrap refuses the sandbox", async () => {
		const marker = join(folder, "ran");
		const done = await execWith({
			sandbox: { kind: "refused", reason: "the fence can't hold here" },
			home: folder,
		})("touch", [marker], folder);
		expect(done.code).toBe(126);
		expect(done.stderr).toContain("the fence can't hold here");
		expect(existsSync(marker)).toBe(false);
	});

	it("is refused, nothing run, where the sandbox refuses it", async () => {
		const marker = join(folder, "ran");
		const exec = execWith({
			sandbox: { kind: "fence" } as unknown as Sandbox,
			wrapping: () => {
				throw new Error("the fence won't start here");
			},
		});
		const done = await exec("touch", [marker], folder);
		expect(done).toMatchObject({ code: 126, killed: false, stdout: "" });
		expect(done.stderr).toContain("the fence won't start here");
		expect(existsSync(marker)).toBe(false);
	});

	it("is refused when the session's environment can't be read", async () => {
		const done = await execWith({
			environment: () => {
				throw new Error("the session has gone");
			},
		})("true", [], folder);
		expect(done.code).toBe(126);
		expect(done.stderr).toContain("the session has gone");
	});

	it("is refused outside the session's folder, nothing run", async () => {
		const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "elsewhere-")));
		try {
			const marker = join(elsewhere, "ran");
			const done = await execWith()("touch", [marker], elsewhere);
			expect(done.code).toBe(126);
			expect(done.stderr).toContain("only in its session's folder");
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("runs in a folder within the session's", async () => {
		const inner = join(folder, "inner");
		mkdirSync(inner);
		const done = await execWith()("pwd", [], inner);
		expect(done).toMatchObject({ stdout: `${inner}\n`, code: 0 });
	});

	it("is refused when no shell is found where the system puts programs", async () => {
		const done = await execWith({ shell: () => undefined })("true", [], folder);
		expect(done.code).toBe(126);
	});

	it("never runs a bash planted on the session's PATH", async () => {
		const planted = join(folder, "bin");
		const marker = join(folder, "planted-ran");
		mkdirSync(planted);
		writeFileSync(
			join(planted, "bash"),
			`#!/bin/sh\ntouch '${marker}'\nexit 0\n`,
		);
		chmodSync(join(planted, "bash"), 0o755);
		const exec = execWith({
			environment: () => ({
				...process.env,
				PATH: `${planted}:${process.env.PATH ?? ""}`,
			}),
		});
		const done = await exec("printf", ["ran"], folder);
		expect(done).toMatchObject({ stdout: "ran", code: 0 });
		expect(existsSync(marker)).toBe(false);
	});

	it("takes what it left running in its group with it when it ends", async () => {
		const done = await execWith()(
			"bash",
			["-c", "sleep 30 >/dev/null 2>&1 & echo $!"],
			folder,
		);
		const left = Number(done.stdout.trim());
		expect(left).toBeGreaterThan(0);
		const gone = () => {
			try {
				process.kill(left, 0);
				return false;
			} catch {
				return true;
			}
		};
		await vi.waitFor(() => expect(gone()).toBe(true), { timeout: 2000 });
	});

	it("is stopped at its time limit", async () => {
		const started = Date.now();
		const done = await execWith()("sleep", ["10"], folder, { timeout: 100 });
		expect(done.killed).toBe(true);
		expect(done.code).not.toBe(0);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("is stopped when its signal aborts", async () => {
		const stop = new AbortController();
		const running = execWith()("sleep", ["10"], folder, {
			signal: stop.signal,
		});
		stop.abort();
		expect((await running).killed).toBe(true);
	});

	it("is stopped at once when its signal has already aborted", async () => {
		const stop = new AbortController();
		stop.abort();
		const started = Date.now();
		const done = await execWith()("sleep", ["10"], folder, {
			signal: stop.signal,
		});
		expect(done.killed).toBe(true);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("is cut off past the most output it may keep, and never says it passed", async () => {
		const done = await execWith({ most: 1000 })("yes", [], folder);
		expect(done.stdout.length).toBe(1000);
		expect(done.stderr).toContain("said more than 1000 bytes");
		expect(done.killed).toBe(true);
		expect(done.code).not.toBe(0);
	});

	it("ends once it exits, though a program it left running holds its output open", async () => {
		const started = Date.now();
		const done = await execWith()(
			"bash",
			["-c", "(sleep 5 &) ; echo left"],
			folder,
		);
		expect(done).toMatchObject({ stdout: "left\n", code: 0 });
		expect(Date.now() - started).toBeLessThan(4000);
	});

	it("ends soon after it exits, though a program it left keeps talking", async () => {
		const started = Date.now();
		const done = await execWith()(
			"bash",
			["-c", "echo left; (while :; do echo more; sleep 0.05; done &)"],
			folder,
		);
		expect(done.code).toBe(0);
		expect(done.stdout.startsWith("left\n")).toBe(true);
		expect(Date.now() - started).toBeLessThan(4000);
	});

	it("is refused once its session has ended", async () => {
		const marker = join(folder, "ran");
		const done = await endedProjectExec("touch", [marker], folder);
		expect(done.code).toBe(126);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("setting a folder's extensions' exec", () => {
	/** A pi as the extension sees it, saying what it was given. */
	function piWith(sets: boolean) {
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => Promise<void> | void
		>();
		const set: ProjectExec[] = [];
		const pi = {
			events: createEventBus(),
			on: (
				event: string,
				handler: (e: unknown, c: unknown) => Promise<void> | void,
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
			getCwd: () => folder,
		},
	});

	beforeEach(() => {
		// The extension reads pi's settings and writes its records under
		// pi's own folder, kept to this test's.
		vi.stubEnv("PI_CODING_AGENT_DIR", join(folder, ".agent"));
		vi.stubEnv(SANDBOX_VARIABLE, OFF);
	});

	it("is asked of a host's pi, whose builds can take one", () => {
		expect(setsProjectExec(piWith(true).pi)).toBe(true);
		expect(setsProjectExec(piWith(false).pi)).toBe(false);
	});

	it("is set once a session starts, never while the extension loads, and refused once it ends", async () => {
		const { pi, handlers, set } = piWith(true);
		shellWorkflow(pi);
		expect(set).toEqual([]);
		await handlers.get("session_start")?.({ type: "session_start" }, ctx());
		expect(set.length).toBeGreaterThanOrEqual(1);
		const done = await set[0]?.("printf", ["ran"], folder);
		expect(done?.stdout).toBe("ran");
		await handlers.get("session_shutdown")?.(
			{ type: "session_shutdown" },
			ctx(),
		);
		expect(set.at(-1)).toBe(endedProjectExec);
	});

	it("is left alone on a pi that can't take one", async () => {
		const { pi, handlers } = piWith(false);
		shellWorkflow(pi);
		await expect(
			handlers.get("session_start")?.({ type: "session_start" }, ctx()),
		).resolves.toBeUndefined();
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx());
	});
});

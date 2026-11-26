/**
 * Reading what pi says when it loads a package, and driving a stand-in
 * pi through the same pipes to check the plumbing: stdin closed after
 * the one request, stderr read for failures, a hang cut off.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkLoad,
	describeLoad,
	LOAD_STOPPED,
	loadCheckArgs,
	loadCheckEnvironment,
	loadFailures,
	readLoad,
} from "../../../../lib/internal/reload/load-check.ts";

const PI_FAILURE = [
	"Error: Failed to load extension \"/t/extensions/advisor/index.ts\": Failed to load extension: Cannot find module '@jitsusama/agentic-harness.core/advisor'",
	"Require stack:",
	"- /t/extensions/advisor/index.ts",
	"Error: Failed to load extension \"/t/extensions/browser/index.ts\": Failed to load extension: Cannot find module 'pixelmatch'",
].join("\n");

const ANSWER = `${JSON.stringify({
	id: "load-check",
	type: "response",
	command: "get_commands",
	success: true,
	data: { commands: [{ name: "a" }, { name: "b" }] },
})}\n`;

describe("reading pi's answer", () => {
	it("names each extension that failed, with its cause", () => {
		expect(loadFailures(PI_FAILURE)).toEqual([
			{
				extension: "/t/extensions/advisor/index.ts",
				error: "Cannot find module '@jitsusama/agentic-harness.core/advisor'",
			},
			{
				extension: "/t/extensions/browser/index.ts",
				error: "Cannot find module 'pixelmatch'",
			},
		]);
	});

	it("passes a load that answered with its commands and failed nothing", () => {
		expect(
			readLoad(`{"type":"extension_ui_request"}\n${ANSWER}`, "", 0),
		).toEqual({ ok: true, failures: [], commands: 2 });
	});

	it("fails a load with failures, whatever pi exited with", () => {
		const report = readLoad("", PI_FAILURE, 1);
		expect(report).toMatchObject({ ok: false });
		expect(report.failures).toHaveLength(2);
	});

	it("fails a pi that exited badly, with the first thing it said", () => {
		expect(readLoad("", "TypeError: boom\n  at x", 1)).toMatchObject({
			ok: false,
			problem: "pi exited with 1: TypeError: boom",
		});
	});

	it("fails a pi that exited cleanly without answering", () => {
		expect(readLoad("", "", 0)).toMatchObject({
			ok: false,
			problem: "pi never answered",
		});
	});

	it("loads the package and nothing else, with no session and no network", () => {
		expect(loadCheckArgs("/t")).toEqual(
			expect.arrayContaining([
				"--no-extensions",
				"--no-session",
				"--offline",
				"--extension",
				"/t",
			]),
		);
	});

	it("keeps the person's configuration and PATH, and nothing of the holder's", () => {
		const env = loadCheckEnvironment(
			{
				PATH: "/bin",
				XDG_CONFIG_HOME: "/home/j/.config",
				XDG_STATE_HOME: "/home/j/.local/state",
				MYCELIUM_WAKE: "/run/user/1000/mycelium/work.held/x.wake",
				KITTY_WINDOW_ID: "174",
				// Inherited from a Mac's host start, and overridden.
				AGENTS_RUNTIME_DIR: "/Users/j/Library/Caches/x",
			},
			"/tmp/box",
		);

		expect(env).toEqual({
			PATH: "/bin",
			XDG_CONFIG_HOME: "/home/j/.config",
			XDG_STATE_HOME: "/tmp/box/state",
			XDG_DATA_HOME: "/tmp/box/data",
			XDG_CACHE_HOME: "/tmp/box/cache",
			XDG_RUNTIME_DIR: "/tmp/box/runtime",
			AGENTS_RUNTIME_DIR: "/tmp/box/runtime",
			PI_NOTIFY: "off",
			PI_LAUNCHER: "off",
			PI_SETTLE: "off",
			PI_OFFLINE: "1",
		});
	});

	it("lists the failures one to a line", () => {
		expect(describeLoad(readLoad("", PI_FAILURE, 1), "~/tree")).toBe(
			[
				"~/tree does not load.",
				"- /t/extensions/advisor/index.ts: Cannot find module '@jitsusama/agentic-harness.core/advisor'",
				"- /t/extensions/browser/index.ts: Cannot find module 'pixelmatch'",
			].join("\n"),
		);
	});
});

describe("asking a pi", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "load-check-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A stand-in pi entry script with this body. */
	function fakePi(body: string): { node: string; entry: string } {
		const entry = join(dir, "pi.mjs");
		writeFileSync(entry, body);
		return { node: process.execPath, entry };
	}

	it("sends one request, waits for stdin to close, and reads the answer", async () => {
		const pi = fakePi(`
			let input = "";
			process.stdin.on("data", (c) => { input += c; });
			process.stdin.on("end", () => {
				const asked = JSON.parse(input.trim());
				process.stdout.write(JSON.stringify({ id: asked.id, type: "response", success: true, data: { commands: [1, 2, 3] } }) + "\\n");
			});
		`);
		expect(await checkLoad(pi, "/t")).toEqual({
			ok: true,
			failures: [],
			commands: 3,
		});
	});

	it("reports the failures a pi writes and its exit", async () => {
		const pi = fakePi(
			`process.stderr.write(${JSON.stringify(PI_FAILURE)}); process.exit(1);`,
		);
		const report = await checkLoad(pi, "/t");
		expect(report).toMatchObject({ ok: false });
		expect(report.failures.map((failure) => failure.error)).toContain(
			"Cannot find module 'pixelmatch'",
		);
	});

	it("gives up on a pi that never finishes loading", async () => {
		const pi = fakePi("setInterval(() => {}, 1000);");
		const report = await checkLoad(pi, "/t", 300);
		expect(report).toMatchObject({
			ok: false,
			problem: "pi was still loading after 1s",
		});
	});

	it("ends a load once whoever asked for it stops, and starts none once already stopped", async () => {
		const pi = fakePi("setInterval(() => {}, 1000);");
		const stop = new AbortController();
		const began = Date.now();
		const loading = checkLoad(pi, "/t", 60_000, stop.signal);
		// Long enough for node to have started before the stop.
		setTimeout(() => stop.abort(), 200);
		expect(await loading).toMatchObject({ ok: false, problem: LOAD_STOPPED });
		expect(Date.now() - began).toBeLessThan(10_000);
		expect(await checkLoad(pi, "/t", 60_000, stop.signal)).toMatchObject({
			ok: false,
			problem: LOAD_STOPPED,
		});
	}, 15_000);

	/**
	 * A stand-in pi that starts a sleeper holding its stdout and stderr,
	 * writing the sleeper's pid to `pids`, apart in a session of its own
	 * when `apart`, then runs `then`.
	 */
	function piLeavingASleeper(
		pids: string,
		apart: boolean,
		then: string,
	): { node: string; entry: string } {
		return fakePi(`
			import { spawn } from "node:child_process";
			import { writeFileSync } from "node:fs";
			const sleeper = spawn("sleep", ["30"], {
				stdio: ["ignore", "inherit", "inherit"],
				detached: ${apart},
			});
			writeFileSync(${JSON.stringify(pids)}, String(sleeper.pid));
			${then}
		`);
	}

	/** End the sleeper whose pid is in `pids`, if it is still there. */
	function endSleeper(pids: string): void {
		if (!existsSync(pids)) return;
		try {
			process.kill(Number(readFileSync(pids, "utf8")), "SIGKILL");
		} catch {
			// The check already ended it, which is what the case wants.
		}
	}

	it("ends a load once pi exits, though a process it started still holds its output", async () => {
		const pids = join(dir, "sleeper");
		const pi = piLeavingASleeper(
			pids,
			false,
			`process.stdout.write(${JSON.stringify(ANSWER)}, () => process.exit(0));`,
		);
		const began = Date.now();
		try {
			expect(await checkLoad(pi, "/t", 60_000)).toMatchObject({
				ok: true,
				commands: 2,
			});
			// Without the group's kill at pi's exit, the sleeper holds the
			// pipes for its 30 s.
			expect(Date.now() - began).toBeLessThan(4000);
		} finally {
			endSleeper(pids);
		}
	}, 15_000);

	it("ends a load once pi exits, though a process in a session of its own holds its output", async () => {
		const pids = join(dir, "sleeper");
		const pi = piLeavingASleeper(
			pids,
			true,
			`process.stdout.write(${JSON.stringify(ANSWER)}, () => process.exit(0));`,
		);
		const began = Date.now();
		try {
			expect(await checkLoad(pi, "/t", 60_000)).toMatchObject({
				ok: true,
				commands: 2,
			});
			// Past the group, only the grace after pi's exit ends the wait.
			expect(Date.now() - began).toBeLessThan(12_000);
		} finally {
			endSleeper(pids);
		}
	}, 20_000);

	it("ends a stopped load with what pi started, not pi alone", async () => {
		const pids = join(dir, "sleeper");
		const pi = piLeavingASleeper(pids, false, "setInterval(() => {}, 1000);");
		const stop = new AbortController();
		const began = Date.now();
		const loading = checkLoad(pi, "/t", 60_000, stop.signal);
		// Long enough for the stand-in to have started its sleeper.
		setTimeout(() => stop.abort(), 500);
		try {
			expect(await loading).toMatchObject({ ok: false, problem: LOAD_STOPPED });
			expect(Date.now() - began).toBeLessThan(4000);
		} finally {
			endSleeper(pids);
		}
	}, 15_000);

	it("starts pi in a sandbox of its own, off the machine's state and this session's ties", async () => {
		const seen = join(dir, "seen.json");
		const pi = fakePi(`
			import * as fs from "node:fs";
			const e = process.env;
			fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
				state: e.XDG_STATE_HOME, runtime: e.XDG_RUNTIME_DIR,
				held: e.MYCELIUM_HELD ?? null, session: e.PI_SESSION_ID ?? null,
				niri: e.NIRI_SOCKET ?? null, launcher: e.PI_LAUNCHER,
			}));
			process.stdout.write(${JSON.stringify(ANSWER)});
		`);
		const before = { ...process.env };
		process.env.MYCELIUM_HELD = "2b685b99";
		process.env.PI_SESSION_ID = "01a1b240";
		process.env.NIRI_SOCKET = "/run/user/1000/niri.sock";
		try {
			expect(await checkLoad(pi, "/t")).toMatchObject({ ok: true });
		} finally {
			process.env = before;
		}
		const env = JSON.parse(readFileSync(seen, "utf8"));

		expect(env).toMatchObject({
			held: null,
			session: null,
			niri: null,
			launcher: "off",
		});
		expect(env.state).not.toBe(process.env.XDG_STATE_HOME);
		expect(env.state).toMatch(/load-check-sandbox-/);
		// And the sandbox goes with the check.
		const sandbox = env.state.replace(/\/state$/, "");
		expect(existsSync(sandbox), `${sandbox} goes with the check`).toBe(false);
	});

	it("says when pi cannot be started at all", async () => {
		const report = await checkLoad(
			{ node: join(dir, "no-such-node"), entry: "x" },
			"/t",
		);
		expect(report).toMatchObject({ ok: false });
		expect(report.problem).toMatch(/^pi would not start/);
	});
});

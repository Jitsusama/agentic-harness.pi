import { describe, expect, it } from "vitest";
import {
	BrowserLaunchFailed,
	classifyLaunchError,
	createIdleCloser,
	formatLaunchFailure,
	killPidGroup,
	killTree,
	reapOrphans,
	shouldCloseWhenIdle,
} from "../../../lib/web/browser.js";

/** A hand-driven timer stand-in: one pending callback, fired on demand. */
function fakeTimers() {
	let pending: (() => void) | undefined;
	let nextId = 1;
	let cleared: number | undefined;
	return {
		setTimer: (fn: () => void) => {
			pending = fn;
			return nextId++ as unknown as NodeJS.Timeout;
		},
		clearTimer: (id: NodeJS.Timeout) => {
			cleared = id as unknown as number;
			pending = undefined;
		},
		fire: () => pending?.(),
		get armed() {
			return pending !== undefined;
		},
		get cleared() {
			return cleared;
		},
	};
}

const PUPPETEER_ERROR = [
	"Failed to launch the browser process:  Code: 21",
	"",
	"stderr:",
	"[0714/153807.1:ERROR:something.cc(42)] framework version mismatch",
	"",
	"TROUBLESHOOTING: https://pptr.dev/troubleshooting",
	"",
].join("\n");

describe("classifyLaunchError", () => {
	it("pulls the exit code and Chrome stderr out of a Puppeteer error", () => {
		const info = classifyLaunchError(new Error(PUPPETEER_ERROR));
		expect(info.exitCode).toBe(21);
		expect(info.chromeStderr).toContain("framework version mismatch");
	});

	it("leaves fields undefined when the error carries no code or stderr", () => {
		const info = classifyLaunchError(new Error("something unrelated"));
		expect(info.exitCode).toBeUndefined();
		expect(info.chromeStderr).toBeUndefined();
	});

	it("tolerates a non-Error value", () => {
		const info = classifyLaunchError("boom");
		expect(info.exitCode).toBeUndefined();
		expect(info.chromeStderr).toBeUndefined();
	});
});

describe("formatLaunchFailure", () => {
	it("names the attempt count and exit code and keeps the Chrome stderr", () => {
		const msg = formatLaunchFailure(
			{ exitCode: 21, chromeStderr: "framework version mismatch" },
			3,
		);
		expect(msg).toContain("3 attempts");
		expect(msg).toContain("21");
		expect(msg).toContain("framework version mismatch");
		// The hint names the common transient cause.
		expect(msg.toLowerCase()).toContain("auto-updating");
	});

	it("omits the exit code clause when the code is unknown", () => {
		const msg = formatLaunchFailure({}, 3);
		expect(msg).not.toContain("exit code");
	});
});

describe("shouldCloseWhenIdle", () => {
	it("closes when only the initial blank page remains", () => {
		expect(shouldCloseWhenIdle(1)).toBe(true);
		expect(shouldCloseWhenIdle(0)).toBe(true);
	});

	it("stays open while a consumer page is present", () => {
		expect(shouldCloseWhenIdle(2)).toBe(false);
		expect(shouldCloseWhenIdle(5)).toBe(false);
	});
});

describe("createIdleCloser", () => {
	it("closes the browser once the idle span elapses after a touch", () => {
		const t = fakeTimers();
		let closes = 0;
		const closer = createIdleCloser({
			idleMs: 1000,
			close: () => {
				closes++;
			},
			setTimer: t.setTimer,
			clearTimer: t.clearTimer,
		});
		closer.touch();
		expect(t.armed).toBe(true);
		t.fire();
		expect(closes).toBe(1);
	});

	it("resets the countdown on each touch", () => {
		const t = fakeTimers();
		let closes = 0;
		const closer = createIdleCloser({
			idleMs: 1000,
			close: () => {
				closes++;
			},
			setTimer: t.setTimer,
			clearTimer: t.clearTimer,
		});
		closer.touch();
		closer.touch();
		// The first timer was cleared before the second was armed.
		expect(t.cleared).toBe(1);
		t.fire();
		expect(closes).toBe(1);
	});

	it("cancel stops a pending close", () => {
		const t = fakeTimers();
		let closes = 0;
		const closer = createIdleCloser({
			idleMs: 1000,
			close: () => {
				closes++;
			},
			setTimer: t.setTimer,
			clearTimer: t.clearTimer,
		});
		closer.touch();
		closer.cancel();
		expect(t.armed).toBe(false);
		t.fire();
		expect(closes).toBe(0);
	});
});

describe("killPidGroup", () => {
	it("kills the negative pid (the whole group) first", () => {
		const calls: Array<[number, string]> = [];
		killPidGroup(4242, (pid, sig) => calls.push([pid, sig]));
		expect(calls).toEqual([[-4242, "SIGKILL"]]);
	});

	it("falls back to the bare pid when the group kill throws", () => {
		const calls: Array<[number, string]> = [];
		killPidGroup(4242, (pid, sig) => {
			if (pid < 0) throw new Error("ESRCH");
			calls.push([pid, sig]);
		});
		expect(calls).toEqual([[4242, "SIGKILL"]]);
	});
});

describe("killTree", () => {
	it("group-kills the process's pid, then falls back to proc.kill", () => {
		const groupKill = (pid: number) => {
			if (pid < 0) throw new Error("ESRCH");
		};
		let fallbackSignal: string | undefined;
		const proc = {
			pid: 99,
			kill: (sig?: string) => {
				fallbackSignal = sig;
				return true;
			},
		};
		killTree(proc, groupKill);
		expect(fallbackSignal).toBe("SIGKILL");
	});

	it("does nothing when there is no process or pid", () => {
		expect(() => killTree(null)).not.toThrow();
		expect(() => killTree({ pid: undefined, kill: () => true })).not.toThrow();
	});
});

describe("reapOrphans", () => {
	type Rec = { piPid: number; piStart: string; browserPid?: number };

	/** A reaper harness: alive pids and their start times, plus owners. */
	function harness(opts: {
		entries: string[];
		owners?: Record<string, Rec>;
		alive?: Record<number, string>; // pid -> start time
		verify?: (pid: number, dir: string) => boolean;
	}) {
		const killed: number[] = [];
		const removed: string[] = [];
		reapOrphans({
			root: "/root",
			currentPid: 100,
			listEntries: () => opts.entries,
			readOwner: (dir) => opts.owners?.[dir.split("/").pop() ?? ""],
			isPidAlive: (pid) => pid in (opts.alive ?? {}),
			startTimeOf: (pid) => opts.alive?.[pid],
			verifyBrowser: opts.verify ?? (() => true),
			killPid: (pid) => killed.push(pid),
			removeDir: (dir) => removed.push(dir),
		});
		return { killed, removed };
	}

	it("leaves a live sibling's profile completely alone", () => {
		const { killed, removed } = harness({
			entries: ["200"],
			owners: { "200": { piPid: 200, piStart: "T1", browserPid: 900 } },
			alive: { 200: "T1" },
		});
		expect(killed).toEqual([]);
		expect(removed).toEqual([]);
	});

	it("reaps a dead owner: kills the recorded browser, removes the dir", () => {
		const { killed, removed } = harness({
			entries: ["200"],
			owners: { "200": { piPid: 200, piStart: "T1", browserPid: 900 } },
			alive: {}, // owner 200 is gone
		});
		expect(killed).toEqual([900]);
		expect(removed).toEqual(["/root/200"]);
	});

	it("treats a reused owner pid as dead (start time mismatch)", () => {
		const { killed, removed } = harness({
			entries: ["200"],
			owners: { "200": { piPid: 200, piStart: "T1", browserPid: 900 } },
			alive: { 200: "T2" }, // pid reused by a different process
		});
		expect(killed).toEqual([900]);
		expect(removed).toEqual(["/root/200"]);
	});

	it("skips the kill but still removes when the browser no longer verifies", () => {
		const { killed, removed } = harness({
			entries: ["200"],
			owners: { "200": { piPid: 200, piStart: "T1", browserPid: 900 } },
			alive: {},
			verify: () => false, // pid 900 is gone or reused by a non-Chrome
		});
		expect(killed).toEqual([]);
		expect(removed).toEqual(["/root/200"]);
	});

	it("without an owner record, skips a dir whose pid is still alive", () => {
		const { killed, removed } = harness({
			entries: ["200"],
			alive: { 200: "T1" },
		});
		expect(killed).toEqual([]);
		expect(removed).toEqual([]);
	});

	it("without an owner record, removes a dir whose pid is dead", () => {
		const { killed, removed } = harness({
			entries: ["200"],
			alive: {},
		});
		expect(killed).toEqual([]);
		expect(removed).toEqual(["/root/200"]);
	});

	it("never touches the current pid's own dir", () => {
		const { killed, removed } = harness({
			entries: ["100"],
			alive: {},
		});
		expect(killed).toEqual([]);
		expect(removed).toEqual([]);
	});

	it("never throws when a kill or a removal fails", () => {
		const removed: string[] = [];
		expect(() =>
			reapOrphans({
				root: "/root",
				currentPid: 100,
				listEntries: () => ["200", "300"],
				readOwner: () => ({ piPid: 1, piStart: "T", browserPid: 9 }),
				isPidAlive: () => false,
				startTimeOf: () => undefined,
				verifyBrowser: () => true,
				killPid: () => {
					throw new Error("kill lost the race");
				},
				removeDir: (dir) => {
					if (dir.endsWith("200")) throw new Error("EACCES");
					removed.push(dir);
				},
			}),
		).not.toThrow();
		// A bad entry does not abort the sweep; the next dir still processes.
		expect(removed).toEqual(["/root/300"]);
	});
});

describe("BrowserLaunchFailed", () => {
	it("derives the exit code and stderr from a Puppeteer cause", () => {
		const err = new BrowserLaunchFailed(new Error(PUPPETEER_ERROR), 3);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("BrowserLaunchFailed");
		expect(err.exitCode).toBe(21);
		expect(err.chromeStderr).toContain("framework version mismatch");
		expect(err.message).toContain("3 attempts");
		expect(err.cause).toBeInstanceOf(Error);
	});

	it("preserves a non-Chrome failure that has no parseable code", () => {
		const fsError = Object.assign(new Error("EACCES: permission denied"), {
			code: "EACCES",
		});
		const err = new BrowserLaunchFailed(fsError, 3);
		expect(err.exitCode).toBeUndefined();
		// The real cause is not swallowed: it shows in the message and cause.
		expect(err.message).toContain("EACCES");
		expect(err.cause).toBe(fsError);
	});
});

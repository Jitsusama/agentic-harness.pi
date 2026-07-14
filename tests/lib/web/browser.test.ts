import { describe, expect, it } from "vitest";
import {
	BrowserLaunchFailed,
	classifyLaunchError,
	createIdleCloser,
	formatLaunchFailure,
	killPidGroup,
	killTree,
	reapOrphans,
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
	it("kills matching processes and removes dirs, skipping the live pid", () => {
		const killed: number[] = [];
		const removed: string[] = [];
		reapOrphans({
			root: "/tmp/pi-web-chrome",
			currentPid: 100,
			listEntries: () => ["100", "200", "300"],
			findProcs: (dir) => (dir.endsWith("200") ? [17579, 17588] : []),
			killPid: (pid) => killed.push(pid),
			removeDir: (dir) => removed.push(dir),
		});
		// The live pid's own dir is left completely alone.
		expect(removed).not.toContain("/tmp/pi-web-chrome/100");
		// Every stale dir is removed; only the matched procs are killed.
		expect(removed).toEqual([
			"/tmp/pi-web-chrome/200",
			"/tmp/pi-web-chrome/300",
		]);
		expect(killed).toEqual([17579, 17588]);
	});

	it("still removes a stale dir when a kill throws", () => {
		const removed: string[] = [];
		reapOrphans({
			root: "/tmp/pi-web-chrome",
			currentPid: 100,
			listEntries: () => ["200"],
			findProcs: () => [1],
			killPid: () => {
				throw new Error("gone");
			},
			removeDir: (dir) => removed.push(dir),
		});
		expect(removed).toEqual(["/tmp/pi-web-chrome/200"]);
	});
});

describe("BrowserLaunchFailed", () => {
	it("is an Error subclass carrying the exit code and stderr", () => {
		const err = new BrowserLaunchFailed(
			{ exitCode: 21, chromeStderr: "boom" },
			3,
		);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("BrowserLaunchFailed");
		expect(err.exitCode).toBe(21);
		expect(err.chromeStderr).toBe("boom");
		expect(err.message).toContain("3 attempts");
	});
});

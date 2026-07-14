import { describe, expect, it } from "vitest";
import {
	BrowserLaunchFailed,
	classifyLaunchError,
	createIdleCloser,
	formatLaunchFailure,
	killPidGroup,
	killTree,
	namesProfile,
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

	it("unrefs the timer so it never keeps the process alive", () => {
		let unrefs = 0;
		const timer = {
			unref: () => {
				unrefs++;
			},
		} as unknown as NodeJS.Timeout;
		const closer = createIdleCloser({
			idleMs: 1000,
			close: () => {},
			setTimer: () => timer,
			clearTimer: () => {},
		});
		closer.touch();
		expect(unrefs).toBe(1);
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

describe("namesProfile", () => {
	const dir = "/tmp/pi-web-chrome/1234-abcd";

	it("matches a command that uses this exact profile", () => {
		expect(namesProfile(`chrome --user-data-dir=${dir} --headless`, dir)).toBe(
			true,
		);
		// Also at end of line.
		expect(namesProfile(`chrome --user-data-dir=${dir}`, dir)).toBe(true);
	});

	it("rejects a longer sibling profile path (prefix collision)", () => {
		expect(namesProfile(`chrome --user-data-dir=${dir}0 --headless`, dir)).toBe(
			false,
		);
	});

	it("rejects a differently-prefixed flag that ends with the value", () => {
		expect(
			namesProfile(`chrome --some-user-data-dir=${dir} --headless`, dir),
		).toBe(false);
	});

	it("does not match when the profile is absent", () => {
		expect(namesProfile("chrome --headless about:blank", dir)).toBe(false);
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
	type Rec = { piPid: number; browserPid?: number };
	const base = (dir: string) => dir.split("/").pop() ?? "";

	/**
	 * A stateful reaper harness. `live` maps a profile to the Chrome pids
	 * actually running on it; a kill removes the pid (unless it is in
	 * `unkillable`, simulating a signal that did not take). `stale` are
	 * pids discovery reports but which no longer verify (a TOCTOU snapshot).
	 */
	function harness(opts: {
		entries: string[];
		owners?: Record<string, Rec>;
		alive?: number[];
		live?: Record<string, number[]>;
		stale?: Record<string, number[]>;
		unkillable?: number[];
		probeFails?: boolean;
	}) {
		const killed: number[] = [];
		const removed: string[] = [];
		const state: Record<string, number[]> = {};
		for (const [k, pids] of Object.entries(opts.live ?? {}))
			state[k] = [...pids];
		const names = (pid: number, dir: string) =>
			(state[base(dir)] ?? []).includes(pid);
		reapOrphans({
			root: "/root",
			listEntries: () => opts.entries,
			readOwner: (dir) => opts.owners?.[base(dir)],
			isPidAlive: (pid) => (opts.alive ?? []).includes(pid),
			verifyBrowser: names,
			findProcsByProfile: (dir) =>
				opts.probeFails
					? undefined
					: [...(state[base(dir)] ?? []), ...(opts.stale?.[base(dir)] ?? [])],
			killPid: (pid) => {
				killed.push(pid);
				if ((opts.unkillable ?? []).includes(pid)) return;
				for (const k of Object.keys(state))
					state[k] = state[k].filter((p) => p !== pid);
			},
			removeDir: (dir) => removed.push(dir),
		});
		return { killed, removed };
	}

	it("leaves a live owner's profile completely alone", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			owners: { "200-a": { piPid: 200, browserPid: 900 } },
			alive: [200],
			live: { "200-a": [900] },
		});
		expect(killed).toEqual([]);
		expect(removed).toEqual([]);
	});

	it("reaps a dead owner: kills the recorded browser, removes the dir", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			owners: { "200-a": { piPid: 200, browserPid: 900 } },
			alive: [],
			live: { "200-a": [900] },
		});
		expect(killed).toEqual([900]);
		expect(removed).toEqual(["/root/200-a"]);
	});

	it("unions discovery with the recorded pid, killing every match", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			owners: { "200-a": { piPid: 200, browserPid: 900 } },
			alive: [],
			live: { "200-a": [900, 901] }, // a stray Chrome on the same profile
		});
		expect(killed.sort()).toEqual([900, 901]);
		expect(removed).toEqual(["/root/200-a"]);
	});

	it("rediscovers the kill target when no browser pid was recorded", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			owners: { "200-a": { piPid: 200 } }, // crashed before recording
			alive: [],
			live: { "200-a": [903] },
		});
		expect(killed).toEqual([903]);
		expect(removed).toEqual(["/root/200-a"]);
	});

	it("skips a stale discovered pid that no longer verifies", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			alive: [],
			live: { "200-a": [] },
			stale: { "200-a": [901] }, // discovery snapshot, but 901 already gone
		});
		expect(killed).toEqual([]); // never signalled a pid that no longer verifies
		expect(removed).toEqual(["/root/200-a"]);
	});

	it("without an owner record, skips a dir whose pid is still alive", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			alive: [200],
		});
		expect(killed).toEqual([]);
		expect(removed).toEqual([]);
	});

	it("without an owner record, reaps a dir whose pid is dead", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			alive: [],
			live: { "200-a": [904] },
		});
		expect(killed).toEqual([904]);
		expect(removed).toEqual(["/root/200-a"]);
	});

	it("removes a dead owner's dir when nothing remains on it", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			owners: { "200-a": { piPid: 200, browserPid: 900 } },
			alive: [],
			live: { "200-a": [] }, // Chrome already exited
		});
		expect(killed).toEqual([]);
		expect(removed).toEqual(["/root/200-a"]);
	});

	it("retains the dir when discovery could not run", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			owners: { "200-a": { piPid: 200, browserPid: 900 } },
			alive: [],
			live: { "200-a": [900] },
			probeFails: true, // ps failed, so we cannot confirm the profile is clear
		});
		// The recorded pid is still killed, but the dir is kept for a retry.
		expect(killed).toEqual([900]);
		expect(removed).toEqual([]);
	});

	it("retains the dir when a signalled pid does not die", () => {
		const { killed, removed } = harness({
			entries: ["200-a"],
			owners: { "200-a": { piPid: 200, browserPid: 900 } },
			alive: [],
			live: { "200-a": [900] },
			unkillable: [900], // kill was sent but the process survived
		});
		expect(killed).toEqual([900]);
		expect(removed).toEqual([]); // kept: a survivor still names the profile
	});

	it("never throws when a kill or a removal fails, and keeps sweeping", () => {
		const removed: string[] = [];
		expect(() =>
			reapOrphans({
				root: "/root",
				listEntries: () => ["200-a", "300-b"],
				// 200-a has a live-verifying Chrome whose kill throws; 300-b is empty.
				readOwner: (dir) =>
					dir.endsWith("200-a") ? { piPid: 1, browserPid: 9 } : undefined,
				isPidAlive: () => false,
				verifyBrowser: (pid) => pid === 9,
				findProcsByProfile: () => [],
				killPid: () => {
					throw new Error("kill lost the race");
				},
				removeDir: (dir) => removed.push(dir),
			}),
		).not.toThrow();
		// 200-a is retained (its Chrome still verifies after the failed kill);
		// the sweep still reaches 300-b and removes it.
		expect(removed).toEqual(["/root/300-b"]);
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

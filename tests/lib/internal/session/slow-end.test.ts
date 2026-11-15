import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	childrenOf,
	slowEndLine,
	watchSlowEnd,
	writeSlowEnd,
} from "../../../../lib/internal/session/slow-end.ts";

/** A process that hears signals, and says so to whoever listens. */
function signals() {
	const listeners = new Map<string, Set<() => void>>();
	return {
		on: (signal: string, listener: () => void) => {
			listeners.set(signal, (listeners.get(signal) ?? new Set()).add(listener));
		},
		off: (signal: string, listener: () => void) => {
			listeners.get(signal)?.delete(listener);
		},
		listenerCount: (signal: string) => listeners.get(signal)?.size ?? 0,
		send: (signal: string) => {
			for (const listener of [...(listeners.get(signal) ?? [])]) listener();
		},
		count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("watchSlowEnd", () => {
	it("says once that a pi is still ending its while after a signal", () => {
		vi.useFakeTimers();
		const source = signals();
		const slow: { cause: string; afterMs: number }[] = [];
		const watch = watchSlowEnd({
			afterMs: 2_000,
			signals: source,
			onSlow: (cause, afterMs) => slow.push({ cause, afterMs }),
		});
		source.on("SIGTERM", () => {});
		source.on("SIGHUP", () => {});
		source.send("SIGTERM");
		vi.advanceTimersByTime(1_999);
		expect(slow, "not before its while").toEqual([]);
		source.send("SIGHUP");
		vi.advanceTimersByTime(1);
		expect(slow, "the first cause, at its while").toEqual([
			{ cause: "SIGTERM", afterMs: 2_000 },
		]);
		vi.advanceTimersByTime(10_000);
		expect(slow, "and only once").toHaveLength(1);
		watch.stop();
	});

	it("starts its while when the session quits, too", () => {
		vi.useFakeTimers();
		const slow: string[] = [];
		const watch = watchSlowEnd({
			afterMs: 2_000,
			signals: signals(),
			onSlow: (cause) => slow.push(cause),
		});
		watch.arm("quit");
		vi.advanceTimersByTime(2_000);
		expect(slow, "a quit that outlasts its while").toEqual(["quit"]);
		watch.stop();
	});

	it("never keeps the process up for its while", () => {
		const unref = vi.fn();
		const watch = watchSlowEnd({
			afterMs: 2_000,
			signals: signals(),
			onSlow: () => {},
			setTimer: () => ({ unref, clear: () => {} }),
		});
		watch.arm("quit");
		expect(unref, "the timer lets the process end").toHaveBeenCalledOnce();
		watch.stop();
	});

	it("listens no more once armed, so a later signal finds pi's own handling", () => {
		const source = signals();
		const watch = watchSlowEnd({
			afterMs: 2_000,
			signals: source,
			onSlow: () => {},
			raise: () => {},
		});
		watch.arm("quit");
		expect(source.count(), "no listener of the watch's").toBe(0);
		watch.stop();
	});

	it("lets a signal nothing else hears end the process as it would", () => {
		const source = signals();
		const raised: string[] = [];
		const watch = watchSlowEnd({
			afterMs: 2_000,
			signals: source,
			onSlow: () => {},
			raise: (signal) => raised.push(signal),
		});
		source.send("SIGHUP");
		expect(raised, "pi's handlers already gone: sent again").toEqual([
			"SIGHUP",
		]);
		watch.stop();
	});

	it("leaves a signal pi still hears to pi", () => {
		const source = signals();
		source.on("SIGTERM", () => {});
		const raised: string[] = [];
		const watch = watchSlowEnd({
			afterMs: 2_000,
			signals: source,
			onSlow: () => {},
			raise: (signal) => raised.push(signal),
		});
		source.send("SIGTERM");
		expect(raised, "pi's handler ends it").toEqual([]);
		watch.stop();
	});

	it("hears nothing more and says nothing once stopped", () => {
		vi.useFakeTimers();
		const source = signals();
		const slow: string[] = [];
		const watch = watchSlowEnd({
			afterMs: 2_000,
			signals: source,
			onSlow: (cause) => slow.push(cause),
		});
		source.on("SIGTERM", () => {});
		source.send("SIGTERM");
		watch.stop();
		vi.advanceTimersByTime(5_000);
		expect(slow, "a reload's old copy stays quiet").toEqual([]);
		expect(source.count(), "only pi's own listener left").toBe(1);
		const unarmed = signals();
		watchSlowEnd({ afterMs: 2_000, signals: unarmed, onSlow: () => {} }).stop();
		expect(unarmed.count(), "a watch stopped unarmed leaves none").toBe(0);
	});
});

describe("childrenOf", () => {
	it("names each child of every thread, by its command", () => {
		const proc = mkdtempSync(join(tmpdir(), "slow-end-proc-"));
		const thread = (pid: number, tid: number, kids: string) => {
			mkdirSync(join(proc, `${pid}`, "task", `${tid}`), { recursive: true });
			writeFileSync(join(proc, `${pid}`, "task", `${tid}`, "children"), kids);
		};
		const command = (pid: number, comm: string) => {
			mkdirSync(join(proc, `${pid}`), { recursive: true });
			writeFileSync(join(proc, `${pid}`, "comm"), `${comm}\n`);
		};
		thread(100, 100, "201 202 ");
		thread(100, 101, "203 ");
		command(201, "git-engine");
		command(202, "busctl");
		expect(childrenOf(100, proc), "203 ended as it was read").toEqual([
			{ pid: 201, command: "git-engine" },
			{ pid: 202, command: "busctl" },
		]);
	});

	it("answers none where it cannot read the process", () => {
		expect(childrenOf(4_242, "/nonexistent"), "no proc, as on macOS").toEqual(
			[],
		);
	});
});

describe("writeSlowEnd", () => {
	const end = {
		pid: 42,
		session: "01a1",
		cause: "SIGTERM",
		afterMs: 2_000,
		active: ["ProcessWrap"],
		children: [{ pid: 201, command: "busctl" }],
	};

	it("keeps the record, with what libuv holds open, and no environment", () => {
		const dir = mkdtempSync(join(tmpdir(), "slow-ends-"));
		const file = writeSlowEnd(end, dir, new Date("2026-11-15T01:00:00Z"));
		expect(file, "named for when and which process").toBe(
			join(dir, "2026-11-15T01-00-00.000Z-42.json"),
		);
		const kept = JSON.parse(readFileSync(file ?? "", "utf8"));
		expect(kept.session, "the record names its session").toBe("01a1");
		expect(kept.children, "and its children").toEqual(end.children);
		expect(Array.isArray(kept.handles), "libuv's handles").toBe(true);
		expect(
			JSON.stringify(kept),
			"no environment, where a key would be",
		).not.toContain("environmentVariables");
	});

	it("keeps only the newest hundred", () => {
		const dir = mkdtempSync(join(tmpdir(), "slow-ends-"));
		for (let i = 0; i < 100; i++) {
			writeFileSync(
				join(dir, `2026-11-14T00-00-${`${i}`.padStart(3, "0")}-1.json`),
				"{}",
			);
		}
		writeSlowEnd(end, dir, new Date("2026-11-15T01:00:00Z"));
		const left = readdirSync(dir).sort();
		expect(left, "a hundred stay").toHaveLength(100);
		expect(left[0], "the oldest went").toBe("2026-11-14T00-00-001-1.json");
	});

	it("answers nothing where it cannot write", () => {
		// Under a file, not /proc: Node's recursive mkdir spins for good
		// on a /proc path.
		const file = join(mkdtempSync(join(tmpdir(), "slow-ends-")), "file");
		writeFileSync(file, "");
		expect(
			writeSlowEnd(end, join(file, "slow-ends")),
			"a full or read-only disk loses the record, not the exit",
		).toBeUndefined();
	});
});

describe("slowEndLine", () => {
	it("says how long, why, the session, what stays open and its children", () => {
		expect(
			slowEndLine(
				{
					pid: 42,
					session: "01a1",
					cause: "SIGTERM",
					afterMs: 2_003.6,
					active: ["TTYWrap", "TCPSocketWrap", "TCPSocketWrap", "Timeout"],
					children: [{ pid: 201, command: "git-engine" }],
				},
				"/state/slow-ends/x.json",
			),
			"the journal's one line on it",
		).toBe(
			"pi: still ending 2004 ms after SIGTERM, session 01a1; open: TTYWrap, TCPSocketWrap×2, Timeout; children: 201 git-engine; report /state/slow-ends/x.json",
		);
	});

	it("says none where nothing is open or running under it", () => {
		expect(
			slowEndLine({
				pid: 42,
				session: "s",
				cause: "quit",
				afterMs: 2_000,
				active: [],
				children: [],
			}),
			"no report written",
		).toBe(
			"pi: still ending 2000 ms after quit, session s; open: none; children: none",
		);
	});
});

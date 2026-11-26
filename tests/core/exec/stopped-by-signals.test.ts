/**
 * A script's commands stopped when the script is told to stop.
 *
 * These run against a stand-in process, since raising a real SIGTERM
 * would end the test runner. That an aborted signal stops a command's
 * whole group is spawnExec's, and spawn.test.ts runs it on real
 * children.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KILL_GRACE_MS } from "../../../lib/core/exec/spawn.ts";
import {
	ENDING,
	type Ended,
	stoppedBySignals,
	WIND_DOWN_MS,
} from "../../../lib/core/exec/stopped-by-signals.ts";

/** A process that records what was done to it and sends signals on demand. */
function standIn(others: Partial<Record<NodeJS.Signals, number>> = {}) {
	const listening = new Map<NodeJS.Signals, Set<() => void>>();
	const killed: NodeJS.Signals[] = [];
	const ended: Ended = {
		pid: 4242,
		once(signal, listener) {
			const set = listening.get(signal) ?? new Set();
			set.add(listener);
			listening.set(signal, set);
		},
		off(signal, listener) {
			listening.get(signal)?.delete(listener);
		},
		listenerCount(signal) {
			return (listening.get(signal)?.size ?? 0) + (others[signal] ?? 0);
		},
		kill(pid, signal) {
			expect(pid).toBe(4242);
			killed.push(signal);
		},
	};
	const send = (signal: NodeJS.Signals): void => {
		const set = listening.get(signal);
		for (const listener of [...(set ?? [])]) {
			// once: the listener is gone before it runs, as Node does.
			set?.delete(listener);
			listener();
		}
	};
	const count = () =>
		[...listening.values()].reduce((sum, set) => sum + set.size, 0);
	return { ended, send, killed, count };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a script told to stop", () => {
	it.each(ENDING)("stops its commands at once on %s, naming it", (sent) => {
		const script = standIn();
		const signal = stoppedBySignals(script.ended);
		expect(signal.aborted, "the signal is not aborted before the stop").toBe(
			false,
		);

		script.send(sent);

		expect(signal.aborted, "the signal is aborted by the stop").toBe(true);
		expect((signal.reason as Error).message).toBe(
			`it was told to stop (${sent})`,
		);
		// Its own flow winds down first: nothing ends it in the same tick.
		expect(script.killed).toEqual([]);
	});

	it.each(ENDING)("is ended by %s once its wind-down is past", (sent) => {
		const script = standIn();
		stoppedBySignals(script.ended, 1_000);

		script.send(sent);
		vi.advanceTimersByTime(999);
		expect(script.killed).toEqual([]);
		vi.advanceTimersByTime(1);

		expect(script.killed).toEqual([sent]);
	});

	it("winds down for longer than spawnExec waits before killing a command", () => {
		expect(WIND_DOWN_MS).toBeGreaterThan(KILL_GRACE_MS);
		const script = standIn();
		stoppedBySignals(script.ended);

		script.send("SIGTERM");
		vi.advanceTimersByTime(KILL_GRACE_MS);
		expect(script.killed).toEqual([]);
		vi.advanceTimersByTime(WIND_DOWN_MS - KILL_GRACE_MS);

		expect(script.killed).toEqual(["SIGTERM"]);
	});

	it("leaves the ending to another listener on that signal, such as a host saving its state", () => {
		const script = standIn({ SIGTERM: 1 });
		const signal = stoppedBySignals(script.ended);

		script.send("SIGTERM");
		vi.advanceTimersByTime(WIND_DOWN_MS * 2);

		expect(
			signal.aborted,
			"the signal is aborted, though another listener ends the work",
		).toBe(true);
		expect(script.killed).toEqual([]);
	});

	it("still ends the script when the other listener is on another signal", () => {
		const script = standIn({ SIGINT: 1 });
		stoppedBySignals(script.ended);

		script.send("SIGTERM");
		vi.advanceTimersByTime(WIND_DOWN_MS);

		expect(script.killed).toEqual(["SIGTERM"]);
	});

	it("takes off every listener it set once one fires, so a second signal ends as usual", () => {
		const script = standIn();
		stoppedBySignals(script.ended);
		expect(script.count()).toBe(ENDING.length);

		script.send("SIGINT");

		expect(script.count()).toBe(0);
	});
});

/**
 * A script's commands stopped when the script is told to stop.
 *
 * The listening rules run against a stand-in process, since raising a
 * real SIGTERM would end the test runner. That the stop reaches a
 * command in its own group runs a real child, since that property is
 * the operating system's.
 */

import { describe, expect, it } from "vitest";
import {
	ENDING,
	type Ended,
	EXIT_ABORTED,
	spawnExec,
	stoppedBySignals,
} from "../../../lib/core/exec/index.ts";
import { until } from "../../support/until.ts";

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

describe("a script told to stop", () => {
	it.each(ENDING)(
		"fires on %s, naming it, and ends as that signal would",
		(sent) => {
			const script = standIn();
			const signal = stoppedBySignals(script.ended);
			expect(signal.aborted).toBe(false);

			script.send(sent);

			expect(signal.aborted).toBe(true);
			expect((signal.reason as Error).message).toBe(
				`it was told to stop (${sent})`,
			);
			expect(script.killed).toEqual([sent]);
		},
	);

	it("leaves the ending to another listener, such as a host saving its state", () => {
		const script = standIn({ SIGTERM: 1 });
		const signal = stoppedBySignals(script.ended);

		script.send("SIGTERM");

		expect(signal.aborted).toBe(true);
		expect(script.killed).toEqual([]);
	});

	it("takes off every listener it set once one fires, so a second signal ends as usual", () => {
		const script = standIn();
		stoppedBySignals(script.ended);
		expect(script.count()).toBe(ENDING.length);

		script.send("SIGINT");
		script.send("SIGINT");
		script.send("SIGTERM");

		expect(script.count()).toBe(0);
		expect(script.killed).toEqual(["SIGINT"]);
	});

	it("does nothing until a signal comes", () => {
		const script = standIn();
		const signal = stoppedBySignals(script.ended);

		expect(signal.aborted).toBe(false);
		expect(script.killed).toEqual([]);
	});
});

describe("a command the script started", () => {
	it("is stopped with its group when the script is told to stop", async () => {
		const script = standIn({ SIGTERM: 1 });
		const running = spawnExec({ signal: stoppedBySignals(script.ended) })(
			"sh",
			["-c", "sleep 30 & echo $!; wait"],
		);
		// Long enough for the shell to have started its own child.
		await new Promise((resolve) => setTimeout(resolve, 300));

		script.send("SIGTERM");
		const result = await running;
		const grandchild = Number(result.stdout.trim());

		expect(result.code).toBe(EXIT_ABORTED);
		expect(result.stderr).toContain("it was told to stop (SIGTERM)");
		expect(grandchild).toBeGreaterThan(0);
		await until(
			"the stopped command's child to be gone",
			() => !alive(grandchild),
			3_000,
		);
	});
});

/** Whether a pid still names a running process. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// ESRCH: nothing by that pid, which is the answer.
		return false;
	}
}

/**
 * Reaping a conversation's tool children: only processes carrying its marker
 * die, each by its whole group, never the host or a process in the host's
 * own group beyond the marked one; and on Linux, a real detached shell and
 * its descendant are gone after one reap.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONVERSATION_MARKER,
	conversationMarker,
	linuxProcessTable,
	marked,
	type ProcessTable,
	parseEnviron,
	parseGroup,
	reapToolChildren,
} from "../../../host/engine/tool-children.ts";

interface FakeProcess {
	group: number;
	env: Record<string, string>;
}

function fakeTable(
	processes: Record<number, FakeProcess>,
	self = 1,
): ProcessTable & { killed: string[] } {
	const live = new Map(
		Object.entries(processes).map(([pid, p]) => [Number(pid), p]),
	);
	const killed: string[] = [];
	return {
		self,
		killed,
		pids: () => [...live.keys()],
		environ: (pid) => live.get(pid)?.env,
		group: (pid) => live.get(pid)?.group,
		kill: (target) => {
			if ("group" in target) {
				killed.push(`group ${target.group}`);
				for (const [pid, p] of live)
					if (p.group === target.group) live.delete(pid);
			} else {
				killed.push(`pid ${target.pid}`);
				live.delete(target.pid);
			}
		},
	};
}

describe("reaping a conversation's tool children", () => {
	it("kills the group of each process carrying its marker, once a group", () => {
		const table = fakeTable({
			1: { group: 1, env: conversationMarker("a") },
			10: { group: 10, env: conversationMarker("a") },
			11: { group: 10, env: conversationMarker("a") },
			20: { group: 20, env: conversationMarker("b") },
			30: { group: 30, env: {} },
		});
		expect(reapToolChildren("a", table)).toEqual({ groups: [10], pids: [] });
		expect(table.killed, "one kill for the one group").toEqual(["group 10"]);
		expect(
			[...table.pids()].sort(),
			"the host, b's child and a stranger live on",
		).toEqual([1, 20, 30]);
	});

	it("kills a marked process in the host's own group alone", () => {
		const table = fakeTable({
			1: { group: 1, env: {} },
			2: { group: 1, env: {} },
			5: { group: 1, env: conversationMarker("a") },
		});
		expect(reapToolChildren("a", table)).toEqual({ groups: [], pids: [5] });
		expect(
			[...table.pids()].sort(),
			"the host's group otherwise untouched",
		).toEqual([1, 2]);
	});

	it("answers nothing when no process carries the marker", () => {
		const table = fakeTable({ 1: { group: 1, env: {} } });
		expect(reapToolChildren("a", table)).toEqual({ groups: [], pids: [] });
		expect(table.killed).toEqual([]);
	});

	it("reads /proc's environ and stat lines, a command with spaces and parentheses included", () => {
		expect(parseEnviron(`A=1\0${CONVERSATION_MARKER}=x=y\0\0`)).toEqual({
			A: "1",
			[CONVERSATION_MARKER]: "x=y",
		});
		expect(parseGroup("4242 (a (weird) cmd) S 1 4240 4240 0 -1")).toBe(4240);
		expect(parseGroup("garbage")).toBeUndefined();
	});
});

describe.runIf(process.platform === "linux")("reaping real processes", () => {
	let child: ChildProcess | undefined;
	afterEach(() => {
		if (child?.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already reaped, as the test expects.
			}
		}
	});

	it("ends a detached shell and the command it started", async () => {
		const id = `reap-${process.pid}-${Date.now()}`;
		child = spawn("sh", ["-c", "sleep 60 & exec sleep 60"], {
			detached: true,
			stdio: "ignore",
			env: { PATH: process.env.PATH, ...conversationMarker(id) },
		});
		const exited = new Promise((resolve) => child?.once("exit", resolve));
		await waitForMarked(id, 2);
		const reaped = reapToolChildren(id);
		expect(reaped.groups, "the shell's own group").toEqual([child.pid]);
		await exited;
		await waitForMarked(id, 0);
	});
});

const POLL_MS = 20;
const MOST_WAIT_MS = 5000;

/** Wait until exactly `count` processes carry the marker. */
async function waitForMarked(id: string, count: number): Promise<void> {
	const table = linuxProcessTable();
	const until = Date.now() + MOST_WAIT_MS;
	while (marked(id, table).length !== count) {
		if (Date.now() > until) {
			throw new Error(
				`expected ${count} marked processes, saw ${marked(id, table).length}`,
			);
		}
		// Polling /proc: a process appears and leaves on the kernel's schedule.
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

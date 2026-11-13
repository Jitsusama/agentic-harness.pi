/**
 * Reaping a conversation's tool children: only processes carrying its marker
 * die, each by its whole group, never the host or a process in the host's
 * own group beyond the marked one; what a dead host under the key left dies
 * at the next start, and a live host's never does; reading the table leaves
 * the host's loop free for its other conversations; and on Linux, a real
 * detached shell and its descendant are gone after one reap.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONVERSATION_MARKER,
	conversationMarker,
	linuxProcessTable,
	marked,
	ownerMark,
	type ProcessTable,
	parseEnviron,
	parseGroup,
	parseStarted,
	reapLeftBehind,
	reapToolChildren,
} from "../../../host/engine/tool-children.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";

/** Calls handed on: none by mark, and the groups named. */
function groupsCarried(...groups: number[]) {
	return { marks: new Set<string>(), groups: new Set(groups) };
}

interface FakeProcess {
	group: number;
	env: Record<string, string>;
	/** When it started, in ticks; 0 unless a case says. */
	started?: number;
}

/** The host the fake table's processes ran under: pid 1, started at tick 0. */
const HOST = { key: "test-host", mark: "1:0" };

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
		environ: async (pid) => live.get(pid)?.env,
		group: (pid) => live.get(pid)?.group,
		started: (pid) => {
			const found = live.get(pid);
			return found === undefined ? undefined : (found.started ?? 0);
		},
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
	it("kills the group of each process carrying its marker, once a group", async () => {
		const table = fakeTable({
			1: { group: 1, env: conversationMarker("a", HOST) },
			10: { group: 10, env: conversationMarker("a", HOST) },
			11: { group: 10, env: conversationMarker("a", HOST) },
			20: { group: 20, env: conversationMarker("b", HOST) },
			30: { group: 30, env: {} },
		});
		expect(await reapToolChildren("a", table)).toEqual({
			groups: [10],
			pids: [],
		});
		expect(table.killed, "one kill for the one group").toEqual(["group 10"]);
		expect(
			[...table.pids()].sort(),
			"the host, b's child and a stranger live on",
		).toEqual([1, 20, 30]);
	});

	it("kills a marked process in the host's own group alone", async () => {
		const table = fakeTable({
			1: { group: 1, env: {} },
			2: { group: 1, env: {} },
			5: { group: 1, env: conversationMarker("a", HOST) },
		});
		expect(await reapToolChildren("a", table)).toEqual({
			groups: [],
			pids: [5],
		});
		expect(
			[...table.pids()].sort(),
			"the host's group otherwise untouched",
		).toEqual([1, 2]);
	});

	it("spares a group handed on to another process, which says its end", async () => {
		const table = fakeTable({
			1: { group: 1, env: {} },
			10: { group: 10, env: conversationMarker("a", HOST) },
			20: { group: 20, env: conversationMarker("a", HOST) },
		});
		expect(await reapToolChildren("a", table, groupsCarried(10))).toEqual({
			groups: [20],
			pids: [],
		});
		expect([...table.pids()].sort(), "the carried call runs on").toEqual([
			1, 10,
		]);
	});

	it("spares what a handed-on call started in a group of its own, as timeout does, by the call's mark", async () => {
		const table = fakeTable({
			1: { group: 1, env: {} },
			10: {
				group: 10,
				env: { ...conversationMarker("a", HOST), [CALL_VARIABLE]: "call-1" },
			},
			11: {
				group: 11,
				env: { ...conversationMarker("a", HOST), [CALL_VARIABLE]: "call-1" },
			},
			20: {
				group: 20,
				env: { ...conversationMarker("a", HOST), [CALL_VARIABLE]: "call-2" },
			},
		});
		const carried = { marks: new Set(["call-1"]), groups: new Set([10]) };
		expect((await reapToolChildren("a", table, carried)).groups).toEqual([
			20,
		]);
		expect(
			[...table.pids()].sort(),
			"the carried call and what it started run on",
		).toEqual([1, 10, 11]);
	});

	it("answers nothing when no process carries the marker", async () => {
		const table = fakeTable({ 1: { group: 1, env: {} } });
		expect(await reapToolChildren("a", table)).toEqual({
			groups: [],
			pids: [],
		});
		expect(table.killed).toEqual([]);
	});

	it("reads /proc's environ and stat lines, a command with spaces and parentheses included", () => {
		expect(parseEnviron(`A=1\0${CONVERSATION_MARKER}=x=y\0\0`)).toEqual({
			A: "1",
			[CONVERSATION_MARKER]: "x=y",
		});
		expect(parseGroup("4242 (a (weird) cmd) S 1 4240 4240 0 -1")).toBe(4240);
		expect(parseGroup("garbage")).toBeUndefined();
		expect(
			parseStarted(
				"4242 (a (weird) cmd) S 1 4240 4240 0 -1 4194560 1 0 0 0 5 2 0 0 20 0 1 0 987654 1000",
			),
		).toBe(987654);
		expect(parseStarted("4242 (cmd) S 1")).toBeUndefined();
	});
});

describe("reaping what a dead host left behind", () => {
	/** An earlier host's mark: pid 7, started at tick 100. */
	const EARLIER = { key: "test-host", mark: "7:100" };

	it("kills what a host under the key that no longer runs left, whichever conversation it was for", async () => {
		const table = fakeTable({
			1: { group: 1, env: {} },
			10: { group: 10, env: conversationMarker("held", EARLIER) },
			20: { group: 20, env: conversationMarker("closing", EARLIER) },
		});
		expect(await reapLeftBehind("test-host", table)).toEqual({
			groups: [10, 20],
			pids: [],
		});
	});

	it("spares what it left that was released to plain pi with its commands", async () => {
		const table = fakeTable({
			1: { group: 1, env: {} },
			10: { group: 10, env: conversationMarker("released", EARLIER) },
			20: { group: 20, env: conversationMarker("held", EARLIER) },
		});
		expect(
			(await reapLeftBehind("test-host", table, groupsCarried(10))).groups,
		).toEqual([20]);
	});

	it("takes a reused pid for a host that no longer runs", async () => {
		const table = fakeTable({
			1: { group: 1, env: {} },
			7: { group: 7, env: {}, started: 555 },
			10: { group: 10, env: conversationMarker("a", EARLIER) },
		});
		expect((await reapLeftBehind("test-host", table)).groups).toEqual([10]);
	});

	it("leaves what a live host started, and what another key's host started", async () => {
		const table = fakeTable({
			1: { group: 1, env: {} },
			7: { group: 7, env: {}, started: 100 },
			10: { group: 10, env: conversationMarker("a", EARLIER) },
			20: {
				group: 20,
				env: conversationMarker("b", { key: "other", mark: "9:1" }),
			},
			30: { group: 30, env: { PI_HOST_CONVERSATION: "before owners" } },
		});
		expect(await reapLeftBehind("test-host", table)).toEqual({
			groups: [],
			pids: [],
		});
		expect(table.killed).toEqual([]);
	});

	it("marks this process as an owner by its pid and start", () => {
		const table = fakeTable({ 1: { group: 1, env: {}, started: 42 } });
		expect(ownerMark(table)).toBe("1:42");
	});
});

describe("reading the process table", () => {
	/** How many processes the made-up table holds: a busy machine has thousands. */
	const PROCESSES = 300;
	let root: string | undefined;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	/** A /proc-shaped folder of processes, none carrying a marker. */
	function madeUpProc(): string {
		const made = mkdtempSync(join(tmpdir(), "tool-children-proc-"));
		for (let pid = 100; pid < 100 + PROCESSES; pid += 1) {
			const folder = join(made, String(pid));
			mkdirSync(folder);
			writeFileSync(join(folder, "environ"), "HOME=/home/x\0PATH=/bin\0");
			writeFileSync(
				join(folder, "stat"),
				`${pid} (sh) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5 1000`,
			);
		}
		return made;
	}

	it("leaves the host's loop free to serve its other conversations while it reads", async () => {
		root = madeUpProc();
		let servedMeanwhile = false;
		setImmediate(() => {
			servedMeanwhile = true;
		});
		const reaped = await reapToolChildren("a", linuxProcessTable(root));
		expect(reaped).toEqual({ groups: [], pids: [] });
		expect(
			servedMeanwhile,
			"the loop ran something else before the reading ended",
		).toBe(true);
	});

	it("answers an environment only where it mentions what is sought, and reaping checks it exactly", async () => {
		root = madeUpProc();
		const table = linuxProcessTable(root);
		expect(await table.environ(100, "HOME=/home")).toEqual({
			HOME: "/home/x",
			PATH: "/bin",
		});
		expect(await table.environ(100, `${CONVERSATION_MARKER}=a`)).toBe(
			undefined,
		);
		expect(await table.environ(100)).toEqual({
			HOME: "/home/x",
			PATH: "/bin",
		});
		expect(await table.environ(99_999), "no such process").toBe(undefined);
		// "a" is how "ab" begins, so the text matches and the parse must not.
		writeFileSync(
			join(root, "101", "environ"),
			`${CONVERSATION_MARKER}=ab\0`,
		);
		expect(await marked("a", table)).toEqual([]);
		expect(await marked("ab", table)).toEqual([101]);
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
			env: {
				PATH: process.env.PATH,
				...conversationMarker(id, { key: id, mark: ownerMark() }),
			},
		});
		const exited = new Promise((resolve) => child?.once("exit", resolve));
		await waitForMarked(id, 2);
		const reaped = await reapToolChildren(id);
		expect(reaped.groups, "the shell's own group").toEqual([child.pid]);
		await exited;
		await waitForMarked(id, 0);
	});

	it("ends what a host under the key that no longer runs left, by its group", async () => {
		const id = `left-${process.pid}-${Date.now()}`;
		// This pid, but a start no running process has: a host gone, its pid since reused.
		const gone = { key: id, mark: `${process.pid}:0` };
		child = spawn("sh", ["-c", "sleep 60 & exec sleep 60"], {
			detached: true,
			stdio: "ignore",
			env: { PATH: process.env.PATH, ...conversationMarker(id, gone) },
		});
		const exited = new Promise((resolve) => child?.once("exit", resolve));
		await waitForMarked(id, 2);
		expect(
			(await reapLeftBehind(`${id}-other`)).groups,
			"another key's start leaves it",
		).toEqual([]);
		expect((await reapLeftBehind(id)).groups).toEqual([child.pid]);
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
	for (;;) {
		const seen = (await marked(id, table)).length;
		if (seen === count) return;
		if (Date.now() > until) {
			throw new Error(`expected ${count} marked processes, saw ${seen}`);
		}
		// Polling /proc: a process appears and leaves on the kernel's schedule.
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

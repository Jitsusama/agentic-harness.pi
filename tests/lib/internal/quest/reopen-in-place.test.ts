/**
 * Settling a session before it is reopened: one a holder runs is left,
 * one held parked is woken in its own window, and a dead one's windows
 * are closed first, never one with a pi still under it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type HeldSession,
	heldSessionsIn,
	type KittyWindowSeen,
	kittyWindowsIn,
	piUnder,
	SESSION_MARK,
	type SettleHost,
	sessionOfCommand,
	settleBeforeReopen,
} from "../../../../lib/internal/quest/reopen-in-place.ts";

const kitty = "unix:@kitty-1";

describe("what the node holds", () => {
	it("reads one session a line, with its windows, and skips what it can't read", () => {
		const output = [
			JSON.stringify({
				id: "fbc6b5bb",
				command: ["pi", "--session-id", "s1"],
				pid: 0,
				parked: true,
				windows: [{ terminal: "kitty", id: "138", within: kitty }],
			}),
			"not json",
			JSON.stringify({ id: "x" }),
			"",
		].join("\n");

		expect(heldSessionsIn(output)).toEqual([
			{
				id: "fbc6b5bb",
				command: ["pi", "--session-id", "s1"],
				pid: 0,
				parked: true,
				windows: [{ terminal: "kitty", id: "138", within: kitty }],
			},
		]);
	});

	it("names the session a held command opens, by either flag", () => {
		expect(sessionOfCommand(["pi", "--session", "s1", "--model", "m"])).toBe(
			"s1",
		);
		expect(sessionOfCommand(["pi", "--session-id", "s2"])).toBe("s2");
		expect(
			sessionOfCommand([
				"pi",
				"--session",
				"/home/j/.pi/agent/sessions/--w--/2026-11-06T21-05-30-270Z_01a1b2ae-49ca.jsonl",
			]),
		).toBe("01a1b2ae-49ca");
		expect(sessionOfCommand(["pi"])).toBeUndefined();
	});
});

describe("a kitty listing", () => {
	it("gives each window's id, process and marks", () => {
		const listing = [
			{
				tabs: [
					{
						windows: [
							{ id: 7, pid: 70, user_vars: { [SESSION_MARK]: "s1" } },
							{ id: 8, user_vars: {} },
						],
					},
				],
			},
		];

		expect(kittyWindowsIn(listing, kitty)).toEqual([
			{ within: kitty, id: "7", pid: 70, marks: { [SESSION_MARK]: "s1" } },
			{ within: kitty, id: "8", marks: {} },
		]);
	});
});

/** A machine holding `held`, showing `windows`, with pis under `withPi`. */
function machine(
	held: HeldSession[] | undefined,
	windows: KittyWindowSeen[],
	options: { withPi?: number[]; alive?: number[]; wakes?: boolean } = {},
) {
	const closed: string[] = [];
	const woke: string[] = [];
	const host: SettleHost = {
		held: async () => held,
		alive: (pid) => (options.alive ?? []).includes(pid),
		piUnder: (pid) => (options.withPi ?? []).includes(pid),
		wake: (session) => {
			woke.push(session);
			return options.wakes ?? true;
		},
		kittyWindows: async (within) =>
			windows.filter((one) => one.within === within),
		close: async (within, id) => {
			closed.push(`${within} ${id}`);
		},
		sockets: [kitty],
	};
	return { host, closed, woke };
}

function holding(
	session: string,
	pid: number,
	extra: Partial<HeldSession> = {},
): HeldSession {
	return {
		id: `holder-${session}`,
		command: ["pi", "--session", session],
		pid,
		parked: false,
		windows: [{ terminal: "kitty", id: "10", within: kitty }],
		...extra,
	};
}

describe("settling before a reopen", () => {
	it("leaves a session a holder runs, closing nothing", async () => {
		const m = machine(
			[holding("s1", 501)],
			[{ within: kitty, id: "10", pid: 100, marks: {} }],
			{ alive: [501], withPi: [100] },
		);
		const settled = await settleBeforeReopen(["s1"], m.host);

		expect(settled).toMatchObject({ running: ["s1"], reopen: [], closed: 0 });
		expect(m.closed).toEqual([]);
	});

	it("wakes a session held parked in its own window rather than starting it again", async () => {
		const m = machine(
			[holding("s1", 0, { parked: true })],
			[{ within: kitty, id: "10", pid: 100, marks: {} }],
		);
		const settled = await settleBeforeReopen(["s1"], m.host);

		expect(settled).toMatchObject({ woken: ["s1"], reopen: [] });
		expect(m.woke).toEqual(["s1"]);
		expect(m.closed).toEqual([]);
	});

	it("reopens nothing for a parked session it can't wake", async () => {
		const m = machine([holding("s1", 0, { parked: true })], [], {
			wakes: false,
		});
		const settled = await settleBeforeReopen(["s1"], m.host);

		expect(settled).toMatchObject({ parked: ["s1"], reopen: [] });
	});

	it("closes a holder's window whose pi is gone, then reopens it", async () => {
		const m = machine(
			[holding("s1", 501)],
			[{ within: kitty, id: "10", pid: 100, marks: {} }],
		);
		const settled = await settleBeforeReopen(["s1"], m.host);

		expect(settled).toMatchObject({ reopen: ["s1"], closed: 1 });
		expect(m.closed).toEqual([`${kitty} 10`]);
	});

	it("closes a window marked with the session once no pi runs in it", async () => {
		const m = machine(
			[],
			[
				{ within: kitty, id: "20", pid: 200, marks: { [SESSION_MARK]: "s1" } },
				{ within: kitty, id: "21", pid: 210, marks: { [SESSION_MARK]: "s2" } },
			],
		);
		const settled = await settleBeforeReopen(["s1"], m.host);

		expect(settled).toMatchObject({ reopen: ["s1"], closed: 1 });
		expect(m.closed).toEqual([`${kitty} 20`]);
	});

	it("keeps a marked window with a pi still under it", async () => {
		const m = machine(
			[],
			[{ within: kitty, id: "20", pid: 200, marks: { [SESSION_MARK]: "s1" } }],
			{ withPi: [200] },
		);
		const settled = await settleBeforeReopen(["s1"], m.host);

		expect(settled).toMatchObject({ reopen: ["s1"], closed: 0 });
		expect(m.closed).toEqual([]);
	});

	it("reopens as before when the node can't say what it holds", async () => {
		const m = machine(undefined, []);
		const settled = await settleBeforeReopen(["s1", "s2"], m.host);

		expect(settled).toEqual({
			running: [],
			woken: [],
			parked: [],
			reopen: ["s1", "s2"],
			closed: 0,
		});
	});
});

describe("a pi under a window", () => {
	let proc: string | undefined;
	afterEach(() => {
		if (proc) rmSync(proc, { recursive: true, force: true });
		proc = undefined;
	});

	/** A /proc folder of processes, each with its name and children. */
	function processes(
		tree: Record<number, { comm: string; children?: number[] }>,
	) {
		const root = mkdtempSync(join(tmpdir(), "proc-"));
		for (const [pid, one] of Object.entries(tree)) {
			mkdirSync(join(root, pid, "task", pid), { recursive: true });
			writeFileSync(join(root, pid, "comm"), `${one.comm}\n`);
			writeFileSync(
				join(root, pid, "task", pid, "children"),
				(one.children ?? []).join(" "),
			);
		}
		return root;
	}

	it("is found below the window's process, through the holder", () => {
		proc = processes({
			1: { comm: "mycelium", children: [2] },
			2: { comm: "mycelium", children: [3] },
			3: { comm: "pi" },
		});

		expect(piUnder(1, proc)).toBe(true);
	});

	it("is not found under a shell whose pi has gone", () => {
		proc = processes({ 1: { comm: "zsh", children: [4] }, 4: { comm: "ls" } });

		expect(piUnder(1, proc)).toBe(false);
		expect(piUnder(9, proc)).toBe(false);
	});
});

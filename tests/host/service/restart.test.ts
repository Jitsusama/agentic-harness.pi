/** When a host restarts itself: only once it would differ and all is settled. */
import {
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	followWhatStarts,
	HELD_SAY_MS,
	type Held,
	RESTART_DUE_MS,
	type RestartFacts,
	restartWhenSettled,
	SETTLE_CEILING_MS,
	settled,
} from "../../../host/service/restart.ts";
import type { Systemctl } from "../../../host/service/what-starts.ts";

const NOW = Date.parse("2026-11-10T20:00:00Z");
const long = new Date(NOW - 10 * 60_000).toISOString();
const lately = new Date(NOW - 30_000).toISOString();

// Timers the test fires by hand, in the order they were set.
function manualTimers() {
	const waiting: { ms: number; run: () => void; cancelled: boolean }[] = [];
	return {
		after(ms: number, run: () => void) {
			const timer = { ms, run, cancelled: false };
			waiting.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		pending: () => waiting.filter((timer) => !timer.cancelled),
		/**
		 * Run the next timer and wait until its look is over: by default
		 * until it set the next, or until `over` says so for one that
		 * restarted and sets none.
		 */
		async fire(over = () => waiting.length > 0) {
			const timer = waiting.shift();
			if (!timer) throw new Error("No timer is waiting");
			if (!timer.cancelled) timer.run();
			await vi.waitFor(
				() => {
					if (!over()) throw new Error("The look hasn't finished");
				},
				// A look awaits only promises the test resolves at once.
				{ interval: 1 },
			);
		},
	};
}

function facts(overrides: Partial<RestartFacts> = {}) {
	const said: string[] = [];
	const base: RestartFacts = {
		differs: async () => "the install moved",
		held: () => [{ state: "idle", since: long }],
		background: () => 0,
		resting: () => true,
		stopping: () => false,
		expect: (coming) => said.push(`expect ${coming}`),
		restart: async (why) => {
			said.push(`restart: ${why}`);
		},
		report: (error) => said.push(`report: ${String(error)}`),
		now: () => NOW,
		...overrides,
	};
	return { facts: base, said };
}

describe("settled", () => {
	it("needs every conversation idle or parked, and unchanged long enough", () => {
		const parked: Held = { state: "parked", since: long };
		expect(settled([], NOW), "a host holding nothing").toBe(true);
		expect(
			settled([{ state: "idle", since: long }, parked], NOW),
			"one idle and one parked, both long since",
		).toBe(true);
		expect(settled([{ state: "busy", since: long }], NOW), "one running").toBe(
			false,
		);
		expect(
			settled([{ state: "idle", since: lately }], NOW),
			"one that just finished",
		).toBe(false);
	});
});

describe("restartWhenSettled", () => {
	it("first looks after the first wait, then every look", async () => {
		const timers = manualTimers();
		const { facts: given } = facts({ differs: async () => undefined });
		restartWhenSettled(given, {
			after: timers.after,
			firstLookMs: 300,
			lookMs: 60,
		});
		expect(timers.pending().map(({ ms }) => ms)).toEqual([300]);
		await timers.fire();
		expect(timers.pending().map(({ ms }) => ms)).toEqual([60]);
	});

	it("expects the restart, then asks for it once, when it differs and all is settled", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts();
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual(["expect true", "restart: the install moved"]);
		expect(
			timers.pending().map(({ ms }) => ms),
			"only the wait for systemd to run it",
		).toEqual([RESTART_DUE_MS]);
	});

	it("stops expecting a restart systemd queued but never ran, and looks again", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({ differs: async () => undefined });
		let first = true;
		given.differs = async () => {
			const why = first ? "the install moved" : undefined;
			first = false;
			return why;
		};
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		await timers.fire();
		expect(said).toEqual([
			"expect true",
			"restart: the install moved",
			"expect false",
			"report: systemd queued the host's restart but never ran it; looking again",
		]);
		expect(timers.pending().map(({ ms }) => ms)).toEqual([60]);
	});

	it("expects no restart systemd refused, and looks again", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			restart: async () => {
				throw new Error("refused");
			},
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual([
			"expect true",
			"expect false",
			"report: Error: refused",
		]);
		expect(timers.pending()).toHaveLength(1);
	});

	it.each([
		["nothing differs", { differs: async () => undefined }],
		[
			"a conversation runs",
			{ held: (): readonly Held[] => [{ state: "busy", since: long }] },
		],
		[
			"a conversation changed lately",
			{ held: (): readonly Held[] => [{ state: "idle", since: lately }] },
		],
		["a screen is in use", { resting: () => false }],
		["background work is held", { background: () => 1 }],
	])("waits while %s", async (_why, overrides) => {
		const timers = manualTimers();
		const { facts: given, said } = facts(overrides);
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual([]);
		expect(timers.pending(), "it looks again").toHaveLength(1);
	});

	// The background host on 12 November: its conversations took turns for
	// 14.5 hours and were never all idle 2 minutes at once, so it never
	// restarted onto the code its install had moved to (OSPHT4 07d3baff).
	it("restarts in a gap between turns once it has waited past the ceiling, never mid-turn", async () => {
		const TURN_MS = 90_000;
		const GAP_MS = 5000;
		const CYCLE_MS = 2 * (TURN_MS + GAP_MS);
		let clock = NOW;
		// One runs 90 s, both rest 5 s, the other runs 90 s, both rest 5 s.
		const one = (start: number): Held => {
			const at = (((clock - NOW - start) % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
			return at < TURN_MS
				? { state: "busy", since: new Date(clock - at).toISOString() }
				: {
						state: "idle",
						since: new Date(clock - (at - TURN_MS)).toISOString(),
					};
		};
		const held = (): readonly Held[] => [one(0), one(TURN_MS + GAP_MS)];
		const timers = manualTimers();
		const seen: Held[][] = [];
		const { facts: given, said } = facts({ held, now: () => clock });
		given.restart = async (why, under) => {
			seen.push([...held()]);
			said.push(`restart under ${under.rule}: ${why}`);
		};
		restartWhenSettled(given, { after: timers.after });
		const giveUp = NOW + 2 * 60 * 60_000;
		while (!said.some((line) => line.startsWith("restart")) && clock < giveUp) {
			clock += timers.pending()[0]?.ms ?? 0;
			await timers.fire();
		}

		expect(
			said.filter((line) => line.startsWith("restart")),
			"it restarted once, saying the rule it restarted under",
		).toEqual(["restart under ceiling: the install moved"]);
		expect(
			clock - NOW,
			"not before it had waited the ceiling for every one to settle",
		).toBeGreaterThanOrEqual(SETTLE_CEILING_MS);
		expect(
			seen[0]?.map(({ state }) => state),
			"in a gap, with no conversation running",
		).toEqual(["idle", "idle"]);
	});

	// The background host on 13 November: a throw began its stop at
	// 18:26:46, which parked five turns mid-way, and at 18:26:50 the loop
	// read the parked host as quiet and asked systemd for a restart on top.
	it("asks for no restart once the host has begun stopping, settled or past the ceiling", async () => {
		for (const ceilingMs of [SETTLE_CEILING_MS, 0]) {
			const timers = manualTimers();
			const { facts: given, said } = facts({
				held: () => [{ state: "parked", since: long }],
				stopping: () => true,
			});
			restartWhenSettled(given, { after: timers.after, ceilingMs });
			await timers.fire();
			await timers.fire();
			expect(said, "nothing restarted").toEqual([]);
		}
	});

	it("still waits past the ceiling while background work is held or a screen is in use", async () => {
		for (const overrides of [
			{ background: () => 1 },
			{ resting: () => false },
		]) {
			const timers = manualTimers();
			const { facts: given, said } = facts({
				held: () => [{ state: "idle", since: lately }],
				...overrides,
			});
			restartWhenSettled(given, { after: timers.after, ceilingMs: 0 });
			await timers.fire();
			await timers.fire();
			expect(
				said.filter((line) => !line.startsWith("report:")),
				"nothing restarted",
			).toEqual([]);
		}
	});

	// On 13 November a background bash always running kept both work hosts
	// on old code for hours, and nothing said why (QCXZEB).
	it("names what holds a restart past the ceiling, once an hour, ending nothing", async () => {
		let clock = NOW;
		const timers = manualTimers();
		const { facts: given, said } = facts({
			background: () => 1,
			holding: () => ["s1: j1 subagent: review"],
			now: () => clock,
		});
		restartWhenSettled(given, { after: timers.after, ceilingMs: 0 });
		for (let look = 0; look < 5; look++) {
			clock += 60_000;
			await timers.fire();
		}
		clock += HELD_SAY_MS;
		await timers.fire();

		expect(said).toEqual([
			"report: Restart held past the ceiling by background work: s1: j1 subagent: review",
			"report: Restart held past the ceiling by background work: s1: j1 subagent: review",
		]);
	});

	it("names nothing while held before the ceiling", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			background: () => 1,
			holding: () => ["s1: j1 subagent: review"],
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		await timers.fire();
		expect(said).toEqual([]);
	});

	it("reports a look that failed and looks again", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			differs: async () => {
				throw new Error("unreadable");
			},
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual(["report: Error: unreadable"]);
		expect(timers.pending()).toHaveLength(1);
	});

	it("looks no more once stopped", async () => {
		const timers = manualTimers();
		const { facts: given } = facts();
		const stop = restartWhenSettled(given, { after: timers.after });
		stop();
		expect(timers.pending()).toEqual([]);
	});
});

describe("followWhatStarts", () => {
	const unit = "pi-host-work-attended.service";
	let dir: string;
	let install: string;
	let cgroup: string;
	let unitFile: string;
	beforeEach(async () => {
		dir = await realpath(await mkdtemp(join(tmpdir(), "h1-restart-")));
		install = join(dir, "install");
		cgroup = join(dir, "cgroup");
		unitFile = join(dir, unit);
		await writeFile(cgroup, `0::/user.slice/app.slice/${unit}\n`);
		await writeFile(unitFile, "[Service]\n");
		for (const [version, body] of [
			["one", "export const a = 1;\n"],
			["same", "export const a = 1;\n"],
			["two", "export const a = 2;\n"],
		] as const) {
			const root = join(install, "versions", version);
			await mkdir(join(root, "scripts"), { recursive: true });
			await mkdir(join(root, "host"), { recursive: true });
			await writeFile(
				join(root, "scripts", "pi-host.ts"),
				'import "../host/a.ts";\n',
			);
			await writeFile(join(root, "host", "a.ts"), body);
		}
		await symlink(join(install, "versions", "one"), join(install, "current"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	// systemd as the test has it: this process the unit's main one, its
	// file the one named, read since it last changed.
	function systemd(main = 7): {
		systemctl: Systemctl;
		calls: string[][];
	} {
		const calls: string[][] = [];
		return {
			calls,
			systemctl: async (args) => {
				calls.push([...args]);
				if (args.includes("--property=MainPID")) return `MainPID=${main}\n`;
				if (args[0] === "show")
					return `NeedDaemonReload=no\nFragmentPath=${unitFile}\nDropInPaths=\n`;
				return "";
			},
		};
	}

	async function follow(systemctl: Systemctl, report = vi.fn()) {
		const timers = manualTimers();
		const serving = {
			held: () => [{ state: "idle" as const, since: long }],
			restartComing: vi.fn(),
			stopping: () => false,
		};
		const stop = await followWhatStarts({
			serving,
			background: () => 0,
			resting: () => true,
			report,
			root: join(install, "versions", "one"),
			systemctl,
			cgroupFile: cgroup,
			pid: 7,
			timing: { after: timers.after, settledMs: 0 },
		});
		return { timers, serving, stop, report };
	}

	async function moveTo(version: string) {
		const next = join(install, "next");
		await symlink(join(install, "versions", version), next);
		await rename(next, join(install, "current"));
	}

	it("restarts its own unit once the install changes the host's own code", async () => {
		const { systemctl, calls } = systemd();
		const { timers, serving, report } = await follow(systemctl);
		await timers.fire();
		expect(serving.restartComing).not.toHaveBeenCalled();

		await moveTo("two");
		await timers.fire(() => calls.at(-1)?.[1] === "restart");

		expect(serving.restartComing).toHaveBeenCalledExactlyOnceWith(true);
		expect(calls.at(-1)).toEqual(["--no-block", "restart", unit]);
		expect(String(report.mock.calls[0]?.[0])).toContain(
			"the install's two changes the host's own code",
		);
	});

	it("says in its journal when it restarts under the ceiling rather than once all settled", async () => {
		const { systemctl, calls } = systemd();
		const timers = manualTimers();
		const report = vi.fn();
		await followWhatStarts({
			serving: {
				// It changed just now, by the clock the host reads.
				held: () => [
					{ state: "idle" as const, since: new Date().toISOString() },
				],
				restartComing: vi.fn(),
				stopping: () => false,
			},
			background: () => 0,
			resting: () => true,
			report,
			root: join(install, "versions", "one"),
			systemctl,
			cgroupFile: cgroup,
			pid: 7,
			timing: { after: timers.after, ceilingMs: 0 },
		});
		await moveTo("two");
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(String(report.mock.calls[0]?.[0])).toBe(
			"Restarting at a moment no conversation had a turn or a job, having waited 0 min for every one to settle 2 min at once, as the install's two changes the host's own code",
		);
	});

	it("stays when the install moves to the same host code", async () => {
		const { systemctl } = systemd();
		const { timers, serving } = await follow(systemctl);
		await moveTo("same");
		await timers.fire();
		expect(serving.restartComing).not.toHaveBeenCalled();
	});

	it("restarts once systemd has read a new unit file", async () => {
		const { systemctl, calls } = systemd();
		const { timers, serving } = await follow(systemctl);
		const next = join(dir, "next.service");
		await writeFile(next, "[Service]\n");
		await rename(unitFile, join(dir, "old.service"));
		await symlink(next, unitFile);
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(serving.restartComing).toHaveBeenCalledExactlyOnceWith(true);
		expect(calls.at(-1)).toEqual(["--no-block", "restart", unit]);
	});

	it("follows nothing where it isn't the unit's main process", async () => {
		const { systemctl, calls } = systemd(8);
		const { timers } = await follow(systemctl);
		expect(timers.pending()).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("follows nothing outside a unit", async () => {
		await writeFile(cgroup, "0::/user.slice/session-2.scope\n");
		const { systemctl, calls } = systemd();
		const { timers } = await follow(systemctl);
		expect(timers.pending()).toEqual([]);
		expect(calls).toEqual([]);
	});
});

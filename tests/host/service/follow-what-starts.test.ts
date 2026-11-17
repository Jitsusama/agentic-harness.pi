/** When a host follows what starts it: its own code, its unit file, its heap. */
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
	type Held,
	LOOK_MS,
} from "../../../host/service/restart.ts";
import type { Systemctl } from "../../../host/service/what-starts.ts";
import { lately, long, MB, manualTimers } from "./restart-fakes.ts";

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

	// A heap far under V8's limit, unless a test says otherwise.
	const small = () => ({ usedBytes: MB, limitBytes: 4144 * MB });

	async function follow(systemctl: Systemctl, report = vi.fn(), heap = small) {
		const timers = manualTimers();
		const serving = {
			held: () => [{ state: "idle" as const, since: long }],
			parked: () => [],
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
			heap,
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
		// No heap is given, so it watches this worker's own collections.
		const stop = await followWhatStarts({
			serving: {
				// It changed just now, by the clock the host reads.
				held: () => [
					{ state: "idle" as const, since: new Date().toISOString() },
				],
				parked: () => [],
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
		stop();
	});

	it("restarts once its heap passes half of what V8 allows, the install unmoved", async () => {
		const { systemctl, calls } = systemd();
		const { timers, serving, report } = await follow(
			systemctl,
			vi.fn(),
			() => ({ usedBytes: 2073 * MB, limitBytes: 4144 * MB }),
		);
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(serving.restartComing).toHaveBeenCalledExactlyOnceWith(true);
		expect(calls.at(-1)).toEqual(["--no-block", "restart", unit]);
		expect(String(report.mock.calls[0]?.[0])).toBe(
			"Restarting once every conversation settled, as its heap holds 2073 of the 4144 MB V8 allows, past half",
		);
	});

	// A host whose heap grew from 1,000 MB at its first look to `usedMb`,
	// holding `held` and `background` jobs: what it journals as it restarts.
	async function heapRestartSaid(
		usedMb: number,
		held: readonly Held[],
		background: number,
		installMoves = false,
	): Promise<string> {
		const { systemctl, calls } = systemd();
		const timers = manualTimers();
		const report = vi.fn();
		let used = 1000 * MB;
		await followWhatStarts({
			serving: {
				held: () => held,
				parked: () => [],
				restartComing: vi.fn(),
				stopping: () => false,
			},
			background: () => background,
			holding: () =>
				// A label a model wrote may carry a newline, which would forge a line.
				[
					"s1: j1 subagent: review\npi-host: forged\u0000\r",
					"s2: j4 codemode",
				].slice(0, background),
			resting: () => true,
			report,
			root: join(install, "versions", "one"),
			systemctl,
			cgroupFile: cgroup,
			pid: 7,
			heap: () => ({ usedBytes: used, limitBytes: 4144 * MB }),
			timing: { after: timers.after },
		});
		await timers.fire();
		used = usedMb * MB;
		if (installMoves) await moveTo("two");
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(calls.at(-1)).toEqual(["--no-block", "restart", unit]);
		return String(report.mock.calls[0]?.[0]);
	}

	// A park takes a conversation out of what the serving host runs and
	// leaves it on its roster, which is how the heap tiers tell a wake.
	it("restarts for no heap a wake refills, as the serving host lists its parks", async () => {
		const { systemctl, calls } = systemd();
		const timers = manualTimers();
		let used = 3100 * MB;
		let parked = false;
		await followWhatStarts({
			serving: {
				held: () =>
					parked
						? []
						: ["a", "b"].map((id) => ({
								id,
								state: "idle" as const,
								since: long,
							})),
				parked: () => (parked ? ["a", "b"] : []),
				restartComing: vi.fn(),
				stopping: () => false,
			},
			background: () => 1,
			resting: () => true,
			report: vi.fn(),
			root: join(install, "versions", "one"),
			systemctl,
			cgroupFile: cgroup,
			pid: 7,
			heap: () => ({ usedBytes: used, limitBytes: 4144 * MB }),
			timing: { after: timers.after },
		});
		// One cycle: on the real clock the wake's window outlasts the case.
		await timers.fire();
		parked = true;
		used = 1650 * MB;
		await timers.fire();
		parked = false;
		used = 3100 * MB;
		for (let look = 0; look < 3; look++) await timers.fire();
		expect(
			calls.filter((call) => call.includes("restart")),
			"no restart asked of systemd",
		).toEqual([]);
	});

	// The reading moves only at V8's full collections, so a reading from
	// while they were parked can stand long after a wake: the mark waits
	// for V8's own count of them, which only the real wiring passes.
	it("lets no reading from before a wake lower the mark, counting V8's collections", async () => {
		const { systemctl, calls } = systemd();
		const timers = manualTimers();
		let used = 3100 * MB;
		let collected: (() => void) | undefined;
		const collect = (mb: number) => {
			used = mb * MB;
			collected?.();
		};
		let parked = false;
		let begun = 1;
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			await followWhatStarts({
				serving: {
					held: () =>
						parked
							? []
							: [{ id: "a", begun, state: "idle" as const, since: long }],
					parked: () => (parked ? ["a"] : []),
					restartComing: vi.fn(),
					stopping: () => false,
				},
				background: () => 1,
				resting: () => true,
				report: vi.fn(),
				root: join(install, "versions", "one"),
				systemctl,
				cgroupFile: cgroup,
				pid: 7,
				heap: () => ({ usedBytes: used, limitBytes: 4144 * MB }),
				watchHeap: (onFull) => {
					collected = onFull;
					return () => undefined;
				},
				timing: { after: timers.after },
			});
			const look = async () => {
				vi.setSystemTime(Date.now() + LOOK_MS);
				await timers.fire();
			};
			collect(3100);
			collect(3100);
			await look();
			collect(3100);
			collect(3100);
			await look();
			parked = true;
			collect(1650);
			collect(1650);
			await look();
			parked = false;
			begun++;
			// An idle host: V8 doesn't collect for an hour after the wake.
			for (let wait = 0; wait < 60; wait++) await look();
			collect(3100);
			collect(3100);
			for (let wait = 0; wait < 3; wait++) await look();
		} finally {
			vi.useRealTimers();
		}
		expect(
			calls.filter((call) => call.includes("restart")),
			"no restart asked of systemd",
		).toEqual([]);
	});

	it("says in its journal how full its heap was and what a heap restart ended", async () => {
		const busy: Held = { state: "busy", since: lately };
		expect(await heapRestartSaid(3400, [busy], 2)).toBe(
			"Restarting with its heap at 82% of what V8 allows, ending 1 running turn and 2 background jobs (s1: j1 subagent: review pi-host: forged; s2: j4 codemode), as its heap holds 3400 of the 4144 MB V8 allows, past half",
		);
	});

	it("gives the heap as the reason for a heap restart, whatever else moved", async () => {
		const busy: Held = { state: "busy", since: lately };
		expect(await heapRestartSaid(3400, [busy], 0, true)).toBe(
			"Restarting with its heap at 82% of what V8 allows, ending 1 running turn, as its heap holds 3400 of the 4144 MB V8 allows, past half",
		);
	});

	it("says in its journal that a heap restart ended nothing, when nothing ran", async () => {
		const idle: Held = { state: "idle", since: new Date().toISOString() };
		expect(await heapRestartSaid(2984, [idle], 0)).toBe(
			"Restarting with its heap at 72% of what V8 allows, ending nothing that was running, as its heap holds 2984 of the 4144 MB V8 allows, past half",
		);
	});

	it("stops watching V8's collections once it stops following", async () => {
		const { systemctl } = systemd();
		const timers = manualTimers();
		let watching = false;
		const stop = await followWhatStarts({
			serving: {
				held: () => [{ state: "idle" as const, since: long }],
				parked: () => [],
				restartComing: vi.fn(),
				stopping: () => false,
			},
			background: () => 0,
			resting: () => true,
			report: vi.fn(),
			root: join(install, "versions", "one"),
			systemctl,
			cgroupFile: cgroup,
			pid: 7,
			watchHeap: () => {
				watching = true;
				return () => {
					watching = false;
				};
			},
			timing: { after: timers.after },
		});
		expect(watching, "watching while following").toBe(true);
		stop();
		expect(watching, "not watching once stopped").toBe(false);
	});

	it("stays while its heap holds half of what V8 allows or less", async () => {
		const { systemctl } = systemd();
		const { timers, serving } = await follow(systemctl, vi.fn(), () => ({
			usedBytes: 2072 * MB,
			limitBytes: 4144 * MB,
		}));
		await timers.fire();
		expect(serving.restartComing).not.toHaveBeenCalled();
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

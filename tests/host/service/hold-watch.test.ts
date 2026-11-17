/**
 * A host's loop watched from a thread beside it: a hold past the bar is
 * said while it lasts and once it ends, with what the main thread did,
 * and a loop that turns says nothing. The loop is held here by spinning,
 * since the test shares it, or by a call that waits in the kernel.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchHolds } from "../../../host/service/hold-watch.ts";
import { clockTicksPerSecond } from "../../../lib/internal/process-ticks.ts";

let dir = "";
let out = "";
let fd = -1;
let stop: (() => void) | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hold-watch-"));
	out = join(dir, "journal");
	fd = openSync(out, "a");
});

afterEach(() => {
	stop?.();
	stop = undefined;
	closeSync(fd);
	rmSync(dir, { recursive: true, force: true });
});

/** Hold this thread's loop for `ms`, as synchronous work would. */
function hold(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {
		// Spinning, as a loop held by synchronous work is.
	}
}

/** The lines written so far. */
function said(): string[] {
	return readFileSync(out, "utf8").split("\n").filter(Boolean);
}

// The thread looks every 100 ms and counts a hold past 500 ms.
const EVERY_MS = 100;
const AFTER_MS = 500;
const ON_LINUX = process.platform === "linux";

describe("watchHolds", () => {
	it("says a hold as it passes the bar, then what held it once the loop turns", async () => {
		stop = watchHolds({ fd, every: EVERY_MS, after: AFTER_MS, still: 60_000 });
		// A turn first, so the thread has started and seen the loop move.
		await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
		hold(1500);
		const during = said();
		expect(
			during,
			`one line while it held: ${during.join(" | ")}`,
		).toHaveLength(1);
		expect(during[0], "said as it passed the bar").toMatch(
			/^pi-host: the loop has held \d+\.\d s so far/,
		);
		await vi.waitFor(() => {
			expect(said().join("\n"), "a line once it turned").toMatch(
				/the loop held /,
			);
		});
		const end = said().find((line) => /the loop held /.test(line)) ?? "";
		const held = Number(/the loop held (\d+\.\d) s/.exec(end)?.[1]);
		expect(held, `about the hold's length: ${end}`).toBeGreaterThanOrEqual(1);
		expect(held, `about the hold's length: ${end}`).toBeLessThan(2);
		if (!ON_LINUX) return;
		const cpu = Number(/ran (\d+\.\d) s on a CPU/.exec(end)?.[1]);
		expect(cpu, `the thread's CPU through the hold: ${end}`).toBeGreaterThan(
			0.5,
		);
		expect(end, "seen running, as a spin is").toMatch(/seen R \d+/);
		expect(end, "the process's swap").toMatch(/swap went from \d+ to \d+ MB/);
		expect(end, "its faults from disk").toMatch(
			/faulted \d+ pages in from disk/,
		);
	});

	it("says a hold again while it lasts, so a kill still leaves a trace", async () => {
		stop = watchHolds({ fd, every: EVERY_MS, after: 300, still: 400 });
		// A turn first, so the thread has started and seen the loop move.
		await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
		hold(1600);
		const during = said().filter((line) => /so far/.test(line));
		expect(
			during.length,
			`said again while it held: ${during.join(" | ")}`,
		).toBeGreaterThanOrEqual(2);
	});

	it.runIf(ON_LINUX)(
		"names the call a held thread waits in, and the path it was given",
		async () => {
			// Opening a pipe to write waits in the kernel until a reader opens it,
			// as a create waits on its folder's lock; a thread of the test's own
			// opens the reader once the hold has been seen.
			const pipe = join(dir, "waited-on");
			expect(spawnSync("mkfifo", [pipe]).status, "a pipe made").toBe(0);
			stop = watchHolds({ fd, every: EVERY_MS, after: 300, still: 60_000 });
			// A turn first, so the thread has started and seen the loop move.
			await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
			const reader = new Worker(
				`const { openSync, closeSync } = require("node:fs");
				setTimeout(() => closeSync(openSync(${JSON.stringify(pipe)}, "r")), 1200);`,
				{ eval: true },
			);
			try {
				closeSync(openSync(pipe, "w"));
				await vi.waitFor(() => {
					expect(said().join("\n"), "a line once it turned").toMatch(
						/the loop held /,
					);
				});
			} finally {
				await reader.terminate();
			}
			const end = said().find((line) => /the loop held /.test(line)) ?? "";
			const home = homedir();
			const shown = pipe.startsWith(`${home}/`)
				? `~${pipe.slice(home.length)}`
				: pipe;
			expect(end, "the call and its path").toContain(`in openat ${shown}`);
		},
	);

	describe("beating the watchdog for a loop held in the disk", () => {
		// The calls the stand-in /proc names, by this machine's numbers; the
		// watch reads no others' numbers, so the cases run only on these two.
		const NUMBERED = process.arch === "x64" || process.arch === "arm64";
		const CALLS =
			process.arch === "arm64"
				? { openat: 56, futex: 98, read: 63 }
				: { openat: 257, futex: 202, read: 0 };
		// The path an openat is given, at address 0 of the stand-in memory.
		const PATH = "/home/one/.local/state/mesh/presence/a.json";

		// Each beat the thread gives is a line in this file, the time it was
		// given in ns, as systemd's notify would hear it.
		const beats = () => join(dir, "beats");
		const beaten = () =>
			existsSync(beats())
				? readFileSync(beats(), "utf8").split("\n").filter(Boolean)
				: [];
		const beat = (
			cap = 60_000,
			command = ["sh", "-c", `date +%s%N >> '${beats()}'`],
		) => ({ every: 300, cap, command, env: process.env });

		/** What the stand-in /proc says of the main thread at one look. */
		interface Look {
			/** Its state: D asleep uninterruptibly, S asleep, R running. */
			readonly state: string;
			/** The kernel function it sleeps in. */
			readonly wchan: string;
			/** The call it waits in. */
			readonly call: keyof typeof CALLS;
			/** The CPU it has used, in s; none by default. */
			readonly cpu?: number;
			/** What its descriptor 3 names, which a read is given. */
			readonly fd?: string;
		}

		/** The thread's own files for a look, by their path under the task. */
		function taskFiles(look: Look): Record<string, string> {
			// The stat's fields after its state; the 11th and 12th are its user
			// and system CPU, in the clock's ticks.
			const rest = Array.from({ length: 40 }, () => "0");
			rest[10] = String(Math.round((look.cpu ?? 0) * clockTicksPerSecond()));
			const given = look.call === "read" ? "0x3 0x0" : "0xffffff9c 0x0";
			return {
				stat: `${process.pid} (node) ${look.state} ${rest.join(" ")}\n`,
				wchan: look.wchan,
				syscall: `${CALLS[look.call]} ${given} 0x0 0x0 0x0 0x0 0x0 0x0\n`,
			};
		}

		/**
		 * A /proc of the main thread's own, saying what `look` says: how the
		 * kernel showed the host's loop through the disk stall of 17
		 * November. The loop is really spinning; the thread reads only this.
		 */
		function procSaying(look: Look): string {
			const proc = join(dir, "proc");
			const task = join(proc, "task", String(process.pid));
			mkdirSync(task, { recursive: true });
			for (const [name, text] of Object.entries(taskFiles(look))) {
				writeFileSync(join(task, name), text);
			}
			writeFileSync(join(proc, "mem"), `${PATH}\0`);
			writeFileSync(join(proc, "status"), "VmSwap:\t0 kB\n");
			mkdirSync(join(proc, "fd"), { recursive: true });
			if (look.fd !== undefined) symlinkSync(look.fd, join(proc, "fd", "3"));
			return proc;
		}

		/**
		 * Have the stand-in /proc say `look` from `seconds` on, while this
		 * thread's loop is held, by a process of its own; its state goes
		 * first, as a look reads it first. Answers the file that says, in
		 * ns, when it did.
		 */
		function sayingLater(proc: string, look: Look, seconds: number): string {
			const next = join(proc, "next");
			mkdirSync(next, { recursive: true });
			const files = taskFiles(look);
			for (const [name, text] of Object.entries(files)) {
				writeFileSync(join(next, name), text);
			}
			const task = join("task", String(process.pid));
			const moves = Object.keys(files)
				.map((name) => `mv next/${name} ${task}/${name}`)
				.join("; ");
			// The wait is the point: the change lands partway through a hold.
			const child = spawn(
				"sh",
				["-c", `sleep ${seconds}; ${moves}; date +%s%N > changed`],
				{ cwd: proc, stdio: "ignore" },
			);
			child.unref();
			return join(proc, "changed");
		}

		/** Wait a few of the thread's looks. */
		const started = () =>
			// A turn first, so the thread has started and seen the loop move.
			new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));

		/** Hold the loop for `ms`, and wait for the line once it turns. */
		async function heldFor(ms: number): Promise<string> {
			hold(ms);
			await vi.waitFor(() => {
				expect(said().join("\n"), "a line once it turned").toMatch(
					/the loop held /,
				);
			});
			return said().join("\n");
		}

		/** Watch with this /proc and beat, as a live host is. */
		const watching = (proc: string | undefined, given = beat()) =>
			watchHolds({
				fd,
				every: EVERY_MS,
				after: 300,
				still: 60_000,
				...(proc !== undefined ? { proc } : {}),
				beat: given,
			});

		const IN_THE_DISK: Look = {
			state: "D",
			wchan: "btrfs_read_lock_root_node",
			call: "openat",
		};

		it.runIf(NUMBERED && ON_LINUX)(
			"beats for a loop asleep in a filesystem call, and says so",
			async () => {
				stop = watching(procSaying(IN_THE_DISK));
				await started();
				const lines = await heldFor(1500);
				expect(
					beaten().length,
					"beats while it slept in the disk",
				).toBeGreaterThanOrEqual(2);
				expect(lines, "each beat journalled").toMatch(
					/beat the watchdog for the loop, held \d+\.\d s in openat \/home\/one\/\.local\/state\/mesh\/presence\/a\.json/,
				);
			},
		);

		it.runIf(NUMBERED && ON_LINUX)(
			"beats for a loop asleep in a call on a file's descriptor",
			async () => {
				const file = "/home/one/.local/state/pi/durable.sqlite-wal";
				stop = watching(
					procSaying({
						state: "D",
						wchan: "folio_wait_bit",
						call: "read",
						fd: file,
					}),
				);
				await started();
				const lines = await heldFor(1500);
				expect(beaten().length, "beats for a file").toBeGreaterThanOrEqual(1);
				expect(lines, "the file named").toContain(`in read ${file}`);
			},
		);

		it.runIf(ON_LINUX)(
			"never beats for a loop running JavaScript",
			async () => {
				stop = watching(undefined);
				await started();
				const lines = await heldFor(1500);
				expect(lines, "seen running").toMatch(/seen R \d+/);
				expect(beaten(), "a spin is the watchdog's to kill").toEqual([]);
			},
		);

		it.runIf(NUMBERED)(
			"never beats for a loop waiting off the disk",
			async () => {
				// Asleep on a lock between threads, which no disk will end.
				stop = watching(
					procSaying({ state: "S", wchan: "futex_wait_queue", call: "futex" }),
				);
				await started();
				await heldFor(1500);
				expect(
					beaten(),
					"a wait off the disk is the watchdog's to kill",
				).toEqual([]);
			},
		);

		it.runIf(NUMBERED)(
			"never beats for a loop held in the kernel on a pipe",
			async () => {
				// Uninterruptible, but on a pipe, which no disk will free.
				stop = watching(
					procSaying({
						state: "D",
						wchan: "pipe_read",
						call: "read",
						fd: "pipe:[42]",
					}),
				);
				await started();
				const lines = await heldFor(1500);
				expect(lines, "the pipe named").toContain("in read pipe:[42]");
				expect(beaten(), "a pipe is the watchdog's to kill").toEqual([]);
			},
		);

		it.runIf(NUMBERED)(
			"never beats for a loop that ran most of its hold on a CPU",
			async () => {
				// Counted from as the loop last moved, so even the hold's first
				// look sees the CPU it ran, which came after it.
				const proc = procSaying(IN_THE_DISK);
				stop = watchHolds({
					fd,
					every: EVERY_MS,
					after: 800,
					still: 60_000,
					proc,
					beat: beat(),
				});
				await started();
				const changed = sayingLater(proc, { ...IN_THE_DISK, cpu: 100 }, 0.2);
				await heldFor(1800);
				expect(existsSync(changed), "its CPU said partway through").toBe(true);
				expect(beaten(), "a busy loop is the watchdog's to kill").toEqual([]);
			},
		);

		it.runIf(NUMBERED && ON_LINUX)(
			"stops beating once the newest look finds the loop off the disk",
			async () => {
				const proc = procSaying(IN_THE_DISK);
				stop = watching(proc);
				await started();
				const changed = sayingLater(
					proc,
					{ state: "S", wchan: "futex_wait_queue", call: "futex" },
					1,
				);
				await heldFor(2500);
				const at = (ns: string) => Number(BigInt(ns) / 1_000_000n);
				const left = at(readFileSync(changed, "utf8").trim());
				const times = beaten().map(at);
				expect(times.length, "beats while in the disk").toBeGreaterThanOrEqual(
					1,
				);
				// A look just before the change may beat just after it; none later.
				expect(
					times.filter((time) => time > left + 3 * EVERY_MS),
					"none once it left the disk",
				).toEqual([]);
			},
		);

		it.runIf(NUMBERED && ON_LINUX)(
			"stops beating at its cap, and says so",
			async () => {
				stop = watching(procSaying(IN_THE_DISK), beat(700));
				await started();
				const lines = await heldFor(2000);
				const atCap = beaten().length;
				expect(atCap, "beats before the cap").toBeGreaterThanOrEqual(1);
				// Four beats' worth from the cap's 700 ms to the hold's 2000 ms
				// would have come had it gone on.
				expect(atCap, "none past the cap").toBeLessThanOrEqual(3);
				expect(lines, "the stop journalled").toMatch(
					/stopped beating the watchdog for the loop at its cap of 0\.7 s/,
				);
			},
		);

		it.runIf(NUMBERED)("says a beat it couldn't send, as one", async () => {
			stop = watching(
				procSaying(IN_THE_DISK),
				beat(60_000, ["sh", "-c", "exit 3"]),
			);
			await started();
			const lines = await heldFor(1500);
			expect(lines, "the failure journalled").toMatch(
				/couldn't beat the watchdog for the loop, held \d+\.\d s in openat \S+: it ended with 3/,
			);
			expect(lines, "no beat claimed").not.toMatch(/pi-host: beat the/);
		});

		it.runIf(NUMBERED)(
			"writes a control character in a path as its code",
			async () => {
				const proc = procSaying(IN_THE_DISK);
				writeFileSync(join(proc, "mem"), "/home/one/a\nb.json\0");
				stop = watching(proc);
				await started();
				const lines = await heldFor(1500);
				expect(lines, "the newline as its code").toContain(
					"in openat /home/one/a\\x0ab.json",
				);
			},
		);
	});

	it("says nothing while the loop turns, nor once stopped", async () => {
		stop = watchHolds({ fd, every: EVERY_MS, after: AFTER_MS });
		// Three bars' worth of a turning loop.
		await new Promise((resolve) => setTimeout(resolve, 3 * AFTER_MS));
		expect(said(), "nothing said of a turning loop").toEqual([]);
		stop();
		stop = undefined;
		hold(2 * AFTER_MS);
		// Long enough for a thread still watching to have looked.
		await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
		expect(said(), "nothing said once stopped").toEqual([]);
	});
});

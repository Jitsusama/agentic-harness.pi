/**
 * A host's loop watched from a thread beside it: a hold past the bar is
 * said while it lasts and once it ends, with what the main thread did,
 * and a loop that turns says nothing. The loop is held here by spinning,
 * since the test shares it, or by a call that waits in the kernel.
 */
import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchHolds } from "../../../host/service/hold-watch.ts";

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
		// Each beat the thread gives is a line in this file, as systemd's
		// notify would hear it.
		const beats = () => join(dir, "beats");
		const beaten = () =>
			existsSync(beats())
				? readFileSync(beats(), "utf8").split("\n").filter(Boolean)
				: [];
		const beat = (cap = 60_000) => ({
			every: 200,
			cap,
			command: ["sh", "-c", `echo WATCHDOG=1 >> '${beats()}'`],
			env: process.env,
		});

		/**
		 * A /proc of the main thread's own, saying it sleeps uninterruptibly
		 * in `wchan` inside the call numbered `call`, whose path argument
		 * reads `path`: how the kernel showed the host's loop through the
		 * disk stall of 17 November. The loop is really spinning; the thread
		 * reads only this.
		 */
		function procSaying(state: string, wchan: string, call: number): string {
			const proc = join(dir, "proc");
			const task = join(proc, "task", String(process.pid));
			mkdirSync(task, { recursive: true });
			const rest = Array.from({ length: 40 }, () => "0").join(" ");
			writeFileSync(
				join(task, "stat"),
				`${process.pid} (node) ${state} ${rest}\n`,
			);
			writeFileSync(join(task, "wchan"), wchan);
			// The path argument is at address 0 of the stand-in memory.
			writeFileSync(
				join(task, "syscall"),
				`${call} 0xffffff9c 0x0 0x0 0x0 0x0 0x0 0x0 0x0\n`,
			);
			writeFileSync(
				join(proc, "mem"),
				"/home/one/.local/state/mesh/presence/a.json\0",
			);
			writeFileSync(join(proc, "status"), "VmSwap:\t0 kB\n");
			mkdirSync(join(proc, "fd"), { recursive: true });
			return proc;
		}

		/** Wait a few of the thread's looks. */
		const started = () =>
			// A turn first, so the thread has started and seen the loop move.
			new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));

		it.runIf(process.arch === "x64")(
			"beats for a loop asleep in a filesystem call, and says so",
			async () => {
				const proc = procSaying("D", "btrfs_read_lock_root_node", 257);
				stop = watchHolds({
					fd,
					every: EVERY_MS,
					after: 300,
					still: 60_000,
					proc,
					beat: beat(),
				});
				await started();
				hold(1500);
				await vi.waitFor(() => {
					expect(said().join("\n"), "a line once it turned").toMatch(
						/the loop held /,
					);
				});
				expect(
					beaten().length,
					"beats while it slept in the disk",
				).toBeGreaterThanOrEqual(2);
				expect(said().join("\n"), "each beat journalled").toMatch(
					/beat the watchdog for the loop, held \d+\.\d s in openat \/home\/one\/\.local\/state\/mesh\/presence\/a\.json/,
				);
			},
		);

		it("never beats for a loop running JavaScript", async () => {
			stop = watchHolds({
				fd,
				every: EVERY_MS,
				after: 300,
				still: 60_000,
				beat: beat(),
			});
			await started();
			hold(1500);
			await vi.waitFor(() => {
				expect(said().join("\n"), "a line once it turned").toMatch(
					/the loop held /,
				);
			});
			expect(beaten(), "a spin is the watchdog's to kill").toEqual([]);
		});

		it.runIf(process.arch === "x64")(
			"never beats for a loop waiting off the disk",
			async () => {
				// Asleep on a lock between threads, which no disk will end.
				const proc = procSaying("S", "futex_wait_queue", 202);
				stop = watchHolds({
					fd,
					every: EVERY_MS,
					after: 300,
					still: 60_000,
					proc,
					beat: beat(),
				});
				await started();
				hold(1500);
				await vi.waitFor(() => {
					expect(said().join("\n"), "a line once it turned").toMatch(
						/the loop held /,
					);
				});
				expect(
					beaten(),
					"a wait off the disk is the watchdog's to kill",
				).toEqual([]);
			},
		);

		it.runIf(process.arch === "x64")(
			"stops beating at its cap, and says so",
			async () => {
				const proc = procSaying("D", "btrfs_read_lock_root_node", 257);
				stop = watchHolds({
					fd,
					every: EVERY_MS,
					after: 300,
					still: 60_000,
					proc,
					beat: beat(700),
				});
				await started();
				hold(2000);
				await vi.waitFor(() => {
					expect(said().join("\n"), "a line once it turned").toMatch(
						/the loop held /,
					);
				});
				const atCap = beaten().length;
				expect(atCap, "beats before the cap").toBeGreaterThanOrEqual(1);
				// Two beats' worth from the cap's 700 ms to the hold's 2000 ms
				// would have come had it gone on.
				expect(atCap, "none past the cap").toBeLessThanOrEqual(3);
				expect(said().join("\n"), "the stop journalled").toMatch(
					/stopped beating the watchdog for the loop at its cap of 0\.7 s/,
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

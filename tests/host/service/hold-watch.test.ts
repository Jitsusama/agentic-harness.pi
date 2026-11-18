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
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
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
		 * ns, when it did, named `name` so one hold may change twice.
		 */
		function sayingLater(
			proc: string,
			look: Look,
			seconds: number,
			name = "changed",
		): string {
			const next = join(proc, `${name}.next`);
			mkdirSync(next, { recursive: true });
			const files = taskFiles(look);
			for (const [name, text] of Object.entries(files)) {
				writeFileSync(join(next, name), text);
			}
			const task = join("task", String(process.pid));
			const moves = Object.keys(files)
				.map((file) => `mv ${name}.next/${file} ${task}/${file}`)
				.join("; ");
			// The wait is the point: the change lands partway through a hold.
			const child = spawn(
				"sh",
				["-c", `sleep ${seconds}; ${moves}; date +%s%N > ${name}`],
				{ cwd: proc, stdio: "ignore" },
			);
			child.unref();
			return join(proc, name);
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

		/** A time a beat or a change was written, in ms. */
		const msOf = (ns: string) => Number(BigInt(ns) / 1_000_000n);

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

		it.runIf(NUMBERED && ON_LINUX)(
			"counts its CPU from as the loop last moved, not from the thread's start",
			async () => {
				// The CPU it ran while the loop turned, after the thread started,
				// is no part of the hold.
				const proc = procSaying(IN_THE_DISK);
				stop = watching(proc);
				await started();
				const ran = sayingLater(proc, { ...IN_THE_DISK, cpu: 3600 }, 0);
				await vi.waitFor(() => {
					expect(existsSync(ran), "its CPU said while it turned").toBe(true);
				});
				await started();
				await heldFor(1500);
				expect(
					beaten().length,
					"beats a stall whatever it ran before",
				).toBeGreaterThanOrEqual(1);
			},
		);

		it.runIf(NUMBERED)(
			"never beats for a loop asleep in a filesystem call it may leave",
			async () => {
				// Interruptible: a FIFO's open waits on its writer, not the disk.
				stop = watching(
					procSaying({ state: "S", wchan: "wait_for_partner", call: "openat" }),
				);
				await started();
				const lines = await heldFor(1500);
				expect(lines, "the call named").toContain(`in openat ${PATH}`);
				expect(beaten(), "only D is the disk's").toEqual([]);
			},
		);

		it.runIf(NUMBERED && ON_LINUX)(
			"keeps beating a stall whose thread a look finds between calls",
			async () => {
				const proc = procSaying(IN_THE_DISK);
				stop = watching(proc);
				await started();
				sayingLater(
					proc,
					{ state: "R", wchan: "0", call: "openat" },
					0.4,
					"ran",
				);
				const back = sayingLater(proc, IN_THE_DISK, 1, "back");
				const lines = await heldFor(2500);
				expect(lines, "seen running partway").toMatch(/seen .*R \d+/);
				expect(existsSync(back), "back in the disk within the hold").toBe(true);
				const returned = msOf(readFileSync(back, "utf8").trim());
				expect(
					beaten()
						.map(msOf)
						.filter((time) => time > returned),
					"beats once back in the disk",
				).not.toEqual([]);
			},
		);

		it.runIf(NUMBERED && ON_LINUX)(
			"sends no beat beside one still out, across holds, and says it once",
			async () => {
				stop = watching(
					procSaying(IN_THE_DISK),
					beat(60_000, ["sh", "-c", `date +%s%N >> '${beats()}'; sleep 30`]),
				);
				await started();
				await heldFor(1500);
				hold(1500);
				await vi.waitFor(() => {
					expect(
						said()
							.join("\n")
							.match(/the loop held /g),
					).toHaveLength(2);
				});
				const lines = said().join("\n");
				expect(beaten().length, "one beat, never answered").toBe(1);
				expect(
					lines.match(/hasn't answered in \d+\.\d s/g),
					"its silence said once",
				).toHaveLength(1);
				expect(lines, "never claimed").not.toMatch(/pi-host: beat the/);
			},
		);

		it.runIf(NUMBERED && ON_LINUX)(
			"says it can't beat any more once its shell is gone",
			async () => {
				// The beat ends the shell that runs it.
				stop = watching(
					procSaying(IN_THE_DISK),
					beat(60_000, ["sh", "-c", "kill -9 $PPID"]),
				);
				await started();
				const lines = await heldFor(1500);
				expect(lines, "the beat out failed").toMatch(
					/couldn't beat the watchdog for the loop, held \d+\.\d s in openat \S+: its shell ended on SIGKILL/,
				);
				expect(lines, "and every one after").toContain(
					"can't beat the watchdog for the loop any more: its shell ended on SIGKILL",
				);
			},
		);

		it.runIf(NUMBERED && ON_LINUX)(
			"ends its shell when the watch stops",
			async () => {
				const shells = join(dir, "shells");
				stop = watching(
					procSaying(IN_THE_DISK),
					beat(60_000, ["sh", "-c", `echo $PPID >> '${shells}'`]),
				);
				await started();
				await heldFor(1000);
				const shell = readFileSync(shells, "utf8").split("\n")[0] ?? "";
				stop();
				stop = undefined;
				// Gone, or ended and left for the host's own end to reap.
				const state = () => {
					try {
						const stat = readFileSync(`/proc/${shell}/stat`, "utf8");
						return stat.slice(
							stat.lastIndexOf(")") + 2,
							stat.lastIndexOf(")") + 3,
						);
					} catch {
						return "gone";
					}
				};
				await vi.waitFor(() => {
					expect(["Z", "gone"], "its shell ended").toContain(state());
				});
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
				const lines = await heldFor(1500);
				expect(lines, "the wait named").toContain("waiting in futex");
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
				// Its first look comes 2 s in, so a change due at 0.2 s lands
				// first even on a loaded lane.
				const proc = procSaying(IN_THE_DISK);
				stop = watchHolds({
					fd,
					every: EVERY_MS,
					after: 2000,
					still: 60_000,
					proc,
					beat: beat(),
				});
				await started();
				const changed = sayingLater(proc, { ...IN_THE_DISK, cpu: 100 }, 0.2);
				await heldFor(2800);
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
				const left = msOf(readFileSync(changed, "utf8").trim());
				const times = beaten().map(msOf);
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
				writeFileSync(join(proc, "mem"), "/home/one/a\nb\u202ec\u200bd.json\0");
				stop = watching(proc);
				await started();
				const lines = await heldFor(1500);
				expect(lines, "the newline and direction mark as codes").toContain(
					"in openat /home/one/a\\x0ab\\u202ec\\u200bd.json",
				);
			},
		);
	});

	describe("profiling a spin", () => {
		/**
		 * How long a case of several spins may take, in ms: their seconds of
		 * spinning and the turns between pass vitest's 5 s on a busy machine.
		 */
		const SPINS_MS = 20_000;

		/** The profiles kept so far, oldest first. */
		const kept = (folder: string): string[] =>
			existsSync(folder)
				? readdirSync(folder)
						.filter((name) => name.endsWith(".cpuprofile"))
						.sort()
				: [];

		/** The lines that say a profile was taken, or couldn't be. */
		const profiled = (): string[] =>
			said().filter((line) =>
				/(profiled|couldn't profile) the held loop/.test(line),
			);

		/** The lines that say whether a profile was kept. */
		const stored = (): string[] =>
			said().filter((line) => /the held loop's profile/.test(line));

		/** A /proc of the main thread's own, saying only its `state`. */
		const procIn = (state: string): string => {
			const proc = join(dir, "proc");
			const task = join(proc, "task", String(process.pid));
			mkdirSync(task, { recursive: true });
			const rest = Array.from({ length: 40 }, () => "0").join(" ");
			writeFileSync(
				join(task, "stat"),
				`${process.pid} (node) ${state} ${rest}\n`,
			);
			writeFileSync(join(proc, "status"), "VmSwap:\t0 kB\n");
			return proc;
		};

		it("profiles the main thread once a spin's hold is long, saying where it spun", {
			timeout: SPINS_MS,
		}, async () => {
			const folder = join(dir, "held");
			stop = watchHolds({
				fd,
				every: EVERY_MS,
				after: 300,
				still: 60_000,
				profile: { after: 600, for: 500, folder },
			});
			// A turn first, so the thread has started and seen the loop move.
			await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
			hold(2500);
			await vi.waitFor(() => {
				expect(stored(), "its keeping said").toHaveLength(1);
			});
			const lines = profiled();
			expect(
				lines,
				`one profile in one hold: ${lines.join(" | ")}`,
			).toHaveLength(1);
			// The spin's own name goes once V8 inlines it into its caller, as it
			// does after the cases before; the file it was written in stays.
			expect(lines[0], "the file it spun in").toContain("hold-watch.test.ts");
			expect(lines[0], "sampled within the hold").not.toMatch(/moved again/);
			const files = kept(folder);
			expect(files, "the profile kept").toHaveLength(1);
			expect(stored()[0], "says where it is kept").toMatch(
				new RegExp(
					`^pi-host: kept the held loop's profile in \\S+${files[0]}$`,
				),
			);
			expect(
				statSync(join(folder, files[0] ?? "")).mode & 0o777,
				"read by its owner alone",
			).toBe(0o600);
			const taken: unknown = JSON.parse(
				readFileSync(join(folder, files[0] ?? ""), "utf8"),
			);
			expect(taken, "a CPU profile, with its samples").toMatchObject({
				nodes: expect.any(Array),
				samples: expect.any(Array),
			});
		});

		it("keeps only the newest profiles", { timeout: SPINS_MS }, async () => {
			const folder = join(dir, "held");
			stop = watchHolds({
				fd,
				every: EVERY_MS,
				after: 300,
				still: 60_000,
				profile: { after: 400, for: 300, folder, keep: 2 },
			});
			for (let time = 1; time <= 3; time += 1) {
				// A turn between holds, so each is a hold of its own.
				await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
				hold(1500);
				await vi.waitFor(() => {
					expect(stored(), `profile ${time} kept`).toHaveLength(time);
				});
			}
			const named = stored().map(
				(line) => /(held-[^ ]+\.cpuprofile)/.exec(line)?.[1],
			);
			expect(kept(folder), "the newest two").toEqual(named.slice(1));
		});

		it("keeps no profile past its size, and says so", async () => {
			const folder = join(dir, "held");
			stop = watchHolds({
				fd,
				every: EVERY_MS,
				after: 300,
				still: 60_000,
				profile: { after: 400, for: 300, folder, most: 10 },
			});
			// A turn first, so the thread has started and seen the loop move.
			await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
			hold(1500);
			await vi.waitFor(() => {
				expect(stored(), "its keeping said").toHaveLength(1);
			});
			expect(profiled()[0], "where it spun, still").toContain(
				"hold-watch.test.ts",
			);
			expect(stored()[0], "too large to keep").toMatch(
				/didn't keep the held loop's profile: at \d+ KB it is too large to keep/,
			);
			expect(kept(folder), "nothing kept").toEqual([]);
		});

		it("says where it spun when the profile can't be kept", async () => {
			// A file where the folder would be, so making the folder fails.
			const folder = join(dir, "held");
			writeFileSync(folder, "");
			stop = watchHolds({
				fd,
				every: EVERY_MS,
				after: 300,
				still: 60_000,
				profile: { after: 400, for: 300, folder },
			});
			// A turn first, so the thread has started and seen the loop move.
			await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
			hold(1500);
			await vi.waitFor(() => {
				expect(stored(), "its keeping said").toHaveLength(1);
			});
			expect(profiled()[0], "where it spun, still").toContain(
				"hold-watch.test.ts",
			);
			expect(stored()[0], "why it wasn't kept").toMatch(
				/^pi-host: couldn't keep the held loop's profile: \S+/,
			);
		});

		it("says when the loop moved before its profile ended", async () => {
			const folder = join(dir, "held");
			stop = watchHolds({
				fd,
				every: EVERY_MS,
				after: 300,
				still: 60_000,
				profile: { after: 400, for: 1500, folder },
			});
			// A turn first, so the thread has started and seen the loop move.
			await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
			// Ends half a second into a profile one and a half seconds long.
			hold(900);
			await vi.waitFor(
				() => {
					expect(profiled(), "a profile said").toHaveLength(1);
				},
				{ timeout: 4000 },
			);
			expect(profiled()[0], "some samples after the hold").toMatch(
				/the loop moved again before it ended/,
			);
		});

		it.runIf(ON_LINUX)(
			"profiles no hold short of its time, nor a thread asleep in the kernel",
			{ timeout: SPINS_MS },
			async () => {
				const folder = join(dir, "held");
				const watch = (proc?: string) =>
					watchHolds({
						fd,
						every: EVERY_MS,
						after: 300,
						still: 60_000,
						...(proc !== undefined ? { proc } : {}),
						profile: { after: 1500, for: 300, folder },
					});
				stop = watch();
				// A turn first, so the thread has started and seen the loop move.
				await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
				hold(1000);
				await vi.waitFor(() => {
					expect(said().join("\n"), "the short hold ended").toMatch(
						/the loop held /,
					);
				});
				expect(profiled(), "no profile short of its time").toEqual([]);
				stop();
				stop = watch(procIn("D"));
				// A turn first, so the thread has started and seen the loop move.
				await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
				hold(2500);
				// Long enough for a profile begun at 1.5 s to have been said.
				await new Promise((resolve) => setTimeout(resolve, 1000));
				expect(profiled(), "no profile of a thread in D").toEqual([]);
				expect(kept(folder), "nothing kept").toEqual([]);
			},
		);

		it.runIf(ON_LINUX)(
			"gives up on a main thread that doesn't answer, and says so",
			async () => {
				const folder = join(dir, "held");
				// Said to be running while it waits in a synchronous spawn, which
				// answers the inspector only once it is back.
				stop = watchHolds({
					fd,
					every: EVERY_MS,
					after: 300,
					still: 60_000,
					proc: procIn("R"),
					profile: { after: 400, for: 300, folder, answer: 300 },
				});
				// A turn first, so the thread has started and seen the loop move.
				await new Promise((resolve) => setTimeout(resolve, 3 * EVERY_MS));
				expect(
					spawnSync("sleep", ["1.5"]).status,
					"held in a native wait",
				).toBe(0);
				await vi.waitFor(() => {
					expect(profiled(), "a profile said").toHaveLength(1);
				});
				expect(profiled()[0], "gave up on its answer").toMatch(
					/couldn't profile the held loop's main thread: the main thread didn't answer Profiler\.enable in 0\.3 s/,
				);
				expect(kept(folder), "nothing kept").toEqual([]);
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

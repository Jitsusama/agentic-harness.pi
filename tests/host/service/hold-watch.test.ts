/**
 * A host's loop watched from a thread beside it: a hold past the bar is
 * said while it lasts and once it ends, with what the main thread did,
 * and a loop that turns says nothing. The loop is held here by spinning,
 * since the test shares it, or by a call that waits in the kernel.
 */
import { spawnSync } from "node:child_process";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
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

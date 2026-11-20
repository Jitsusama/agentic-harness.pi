/**
 * pi-sweep as its timer runs it: node running the script as it stands,
 * in a sealed environment of its own, sweeping once and saying so.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "pi-sweep.ts");

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A home of its own, and the sweep's state folder in it, not yet made. */
function freshHome(): { home: string; work: string } {
	const home = mkdtempSync(join(tmpdir(), "pi-sweep-"));
	made.push(home);
	return {
		home,
		work: join(home, "state", "pi", "agentic-harness.pi", "work"),
	};
}

/** Run the script once, as its timer would, in `home` alone. */
async function sweepIn(home: string): Promise<void> {
	await run(
		process.execPath,
		["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT],
		{
			env: {
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: home,
				XDG_STATE_HOME: join(home, "state"),
				XDG_DATA_HOME: join(home, "data"),
				XDG_CONFIG_HOME: join(home, "config"),
			},
			timeout: 20_000,
		},
	);
}

/** The sweep log's lines, each as the object it was written from. */
function logLines(work: string): Record<string, unknown>[] {
	return readFileSync(join(work, "sweep.log"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

it("sweeps once on a machine that has never swept, standing the hosts' sweeps down", async () => {
	const { home, work } = freshHome();

	await sweepIn(home);

	expect(
		existsSync(join(work, "sweep.lock.outside")),
		"the stamp that stands the hosts' sweeps down",
	).toBe(true);
	expect(logLines(work), "one line for its one sweep").toHaveLength(1);
	// The stamp is dated in whole milliseconds through a float of seconds,
	// which can read back a hair under its millisecond, and the log by the
	// file system: a millisecond's slack keeps both on one footing.
	expect(
		statSync(join(work, "sweep.lock.outside")).mtimeMs,
		"the stamp dated once the sweep ended",
	).toBeGreaterThanOrEqual(
		Math.floor(statSync(join(work, "sweep.log")).mtimeMs) - 1,
	);
	expect(
		existsSync(join(work, "sweep.lock")),
		"a lock left behind once it was done",
	).toBe(false);
});

it("sweeps though a sweep has only just ended, which a host's would rest after", async () => {
	const { home, work } = freshHome();
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "sweep.lock.ended"), "");

	await sweepIn(home);

	const lines = logLines(work);
	expect(lines, "one line for its one sweep").toHaveLength(1);
	expect(lines[0], "a sweep that ran, rather than failed or rested").toEqual(
		expect.objectContaining({ taken: [], refused: [] }),
	);
});

it("leaves the hosts sweeping when its sweep fails", async () => {
	const { home, work } = freshHome();
	mkdirSync(work, { recursive: true });
	// Where the trees' records go, as a file: the sweep can't list them.
	writeFileSync(join(work, "cut"), "");

	await sweepIn(home);

	expect(logLines(work)[0], "the line it logged").toHaveProperty("failed");
	expect(
		existsSync(join(work, "sweep.lock.outside")),
		"a stamp standing the hosts down after a sweep that failed",
	).toBe(false);
});

it("leaves the hosts sweeping when another sweep holds the lock", async () => {
	const { home, work } = freshHome();
	// A lock it can't take or read, as one another sweep is making.
	mkdirSync(join(work, "sweep.lock"), { recursive: true });

	await sweepIn(home);

	expect(logLines(work)[0], "the line it logged").toHaveProperty("skipped");
	expect(
		existsSync(join(work, "sweep.lock.outside")),
		"a stamp standing the hosts down after a sweep that never ran",
	).toBe(false);
});

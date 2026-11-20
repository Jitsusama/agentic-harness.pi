/**
 * pi-sweep as its timer runs it: node running the script as it stands,
 * in a sealed environment of its own, sweeping once and saying so.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

it("sweeps once outside any host, standing the hosts' sweeps down and logging the sweep", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-sweep-"));
	made.push(home);
	const work = join(home, "state", "pi", "agentic-harness.pi", "work");

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

	expect(
		existsSync(join(work, "sweep.lock.outside")),
		"the stamp that stands the hosts' sweeps down",
	).toBe(true);
	const lines = readFileSync(join(work, "sweep.log"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	expect(lines, "one line for its one sweep").toHaveLength(1);
	expect(lines[0], "a sweep that ran, rather than failed or rested").toEqual(
		expect.objectContaining({ taken: [], refused: [] }),
	);
	expect(
		existsSync(join(work, "sweep.lock")),
		"a lock left behind once it was done",
	).toBe(false);
});

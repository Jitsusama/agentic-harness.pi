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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, it as everywhere, expect } from "vitest";
import {
	listsFirstProcess,
	seesEveryProcess,
} from "../../extensions/work-integration/sweep.ts";

const run = promisify(execFile);
// The script fails before sweeping where it can't see every process, as
// in the agents' fence, on a Mac or under a /proc that hides others'
// processes, so its cases run only where it can.
const it = everywhere.skipIf(
	!(await seesEveryProcess()) || !(await listsFirstProcess()),
);
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "pi-sweep.ts");
// Each case starts node afresh, which a loaded machine can keep past
// vitest's few seconds; the run's own clock is 20 s.
const CASE_MS = 30_000;

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A home of its own, and the sweep's state folder in it, not yet made. */
function freshHome(): { home: string; work: string } {
	const home = mkdtempSync(join(tmpdir(), "pi-sweep-"));
	made.push(home);
	// Where the quests are by default, which a machine that runs pi has.
	mkdirSync(
		join(home, "data", "pi", "agentic-harness.pi", "quest-workflow", "quests"),
		{ recursive: true },
	);
	return {
		home,
		work: join(home, "state", "pi", "agentic-harness.pi", "work"),
	};
}

/**
 * Run the script once, as its timer would, in `home` alone, and give the
 * code it exited with.
 */
async function sweepIn(home: string, timeout = 20_000): Promise<number> {
	try {
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
				timeout,
			},
		);
		return 0;
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "number") return code;
		throw error;
	}
}

/** The sweep log's lines, each as the object it was written from. */
function logLines(work: string): Record<string, unknown>[] {
	return readFileSync(join(work, "sweep.log"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

it(
	"sweeps once on a machine that has never swept, standing the hosts' sweeps down",
	async () => {
		const { home, work } = freshHome();

		expect(await sweepIn(home), "the code it exited with").toBe(0);

		expect(
			JSON.parse(readFileSync(join(work, "sweep.lock.outside"), "utf8")),
			"the stamp that stands the hosts' sweeps down",
		).toEqual({ judged: ["git-worktree"] });
		expect(logLines(work), "one line for its one sweep").toHaveLength(1);
		expect(
			existsSync(join(work, "sweep.lock")),
			"a lock left behind once it was done",
		).toBe(false);
	},
	CASE_MS,
);

it(
	"sweeps though a sweep has only just ended, which a host's would rest after",
	async () => {
		const { home, work } = freshHome();
		mkdirSync(work, { recursive: true });
		writeFileSync(join(work, "sweep.lock.ended"), "");

		await sweepIn(home);

		const lines = logLines(work);
		expect(lines, "one line for its one sweep").toHaveLength(1);
		expect(lines[0], "a sweep that ran, rather than failed or rested").toEqual(
			expect.objectContaining({ taken: [], refused: [] }),
		);
	},
	CASE_MS,
);

it(
	"leaves the hosts sweeping when its sweep fails",
	async () => {
		const { home, work } = freshHome();
		mkdirSync(work, { recursive: true });
		// Where the trees' records go, as a file: the sweep can't list them.
		writeFileSync(join(work, "cut"), "");

		expect(await sweepIn(home), "the code it exited with").toBe(1);

		expect(logLines(work)[0]?.failed, "the line it logged").toContain(
			"ENOTDIR",
		);
		expect(
			existsSync(join(work, "sweep.lock.outside")),
			"a stamp standing the hosts down after a sweep that failed",
		).toBe(false);
	},
	CASE_MS,
);

it("waits its turn behind another sweep rather than standing down", async () => {
	const { home, work } = freshHome();
	// A lock it can't take or read, as one another sweep is making, let
	// go a second in: the run looks again ten seconds after its first
	// try, as it would behind a host's sweep.
	const lock = join(work, "sweep.lock");
	mkdirSync(lock, { recursive: true });
	const letGo = setTimeout(
		() => rmSync(lock, { recursive: true, force: true }),
		1000,
	);

	try {
		expect(await sweepIn(home, 45_000), "the code it exited with").toBe(0);
	} finally {
		clearTimeout(letGo);
	}

	expect(
		logLines(work).map((line) => line.skipped),
		"what it logged as skipped",
	).not.toContain("another sweep is starting");
}, 60_000);

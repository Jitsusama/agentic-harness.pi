/**
 * pi-fence: runs one command in pi's fence for a caller outside pi, such
 * as the mycelium node starting an agent's `mycelium run` through its
 * declared `runs` prefix (lib/internal/fence-run.ts says the whole of it):
 *
 *   node scripts/pi-fence.ts --kind fence|strict [--folder DIR] -- PROGRAM [ARGUMENT...]
 *   node scripts/pi-fence.ts census [--proc DIR]
 *
 * The folder is the working directory unless named. The command's own
 * output and input pass straight through, and pi-fence exits with its
 * status, 128 and the signal's number when a signal ended it. It exits
 * 126, saying why on stderr, when it refuses to run, and 2 when it was
 * asked wrongly. `--help` says how to ask it, on stdout.
 *
 * The census judges every live session on the machine, in every realm,
 * by its commands' processes (lib/internal/fence-census.ts), says so on
 * stdout, and exits 1 when one runs unfenced or /proc can't be read.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { constants, homedir } from "node:os";
import { join } from "node:path";
import {
	censusHolds,
	censusText,
	fenceCensus,
} from "../lib/internal/fence-census.ts";
import {
	FENCE_RUN_HELP,
	fenceRunAsked,
	fenceRunText,
} from "../lib/internal/fence-run.ts";
import { stageFolder } from "../lib/internal/fence-stage.ts";
import { everyRealmsDir } from "../lib/internal/paths.ts";
import { createPresences } from "../lib/mesh/presence.ts";

/** The status a refusal exits with, as a shell's for a command it can't run. */
const REFUSED = 126;

/** The status a wrong asking exits with. */
const ASKED_WRONGLY = 2;

/** The status a signal's end gives, as a shell reports it. */
const SIGNALLED = 128;

/** The status a census finding a session unfenced exits with. */
const UNFENCED = 1;

/** Clock ticks per second where getconf can't say, as Linux has it. */
const USUAL_TICKS = 100;

/** This machine's clock ticks per second, which /proc counts starts in. */
function ticksPerSecond(): number {
	try {
		const said = Number(
			execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }),
		);
		return Number.isSafeInteger(said) && said > 0 ? said : USUAL_TICKS;
	} catch {
		// No getconf on PATH: Linux's own count is right on every machine pi runs.
		return USUAL_TICKS;
	}
}

const asked = fenceRunAsked(process.argv.slice(2), process.cwd());
if ("help" in asked) {
	process.stdout.write(FENCE_RUN_HELP);
	process.exit(0);
}
if ("wrong" in asked) {
	process.stderr.write(`pi-fence: ${asked.wrong}\n`);
	process.exit(ASKED_WRONGLY);
}
if ("census" in asked) {
	const census = fenceCensus({
		proc: asked.census,
		presences: everyRealmsDir("state", "mesh-workflow").flatMap((mesh) =>
			createPresences(join(mesh, "presence")).all(),
		),
		stage: stageFolder(),
		ticksPerSecond: ticksPerSecond(),
	});
	process.stdout.write(censusText(census));
	process.exit(censusHolds(census) ? 0 : UNFENCED);
}
const made = fenceRunText(asked, { env: process.env, home: homedir() });
if ("refused" in made) {
	process.stderr.write(`pi-fence: ${made.refused}\n`);
	process.exit(REFUSED);
}
const ran = spawnSync("bash", ["-c", made.text], {
	cwd: made.folder,
	stdio: "inherit",
});
if (ran.error) {
	process.stderr.write(`pi-fence: bash didn't start: ${ran.error.message}\n`);
	process.exit(REFUSED);
}
const signal = ran.signal ? constants.signals[ran.signal] : undefined;
process.exit(
	signal === undefined ? (ran.status ?? REFUSED) : SIGNALLED + signal,
);
